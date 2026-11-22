// Sokoban solver for make.fun's "Build the best Sokoban solver" bounty.
//
// Strategy
// --------
// Every level is a 1-wide hallway with 1-4 small rooms (3-4 boxes each) off
// it, and a box pushed out of its room can never come back, so a level's
// push-optimal count is the sum of its rooms' push-optima. This solver
// therefore:
//   1. splits the level into rooms (connected floor components off the
//      hallway row the player starts in),
//   2. solves each room push-optimally with A* over pushes, using an
//      admissible heuristic (minimum-cost assignment of boxes to goals,
//      where the cost is the push-distance ignoring other boxes) plus
//      deadlock pruning (dead squares, frozen 2x2 blocks),
//   3. stitches the room solutions together with player walks through
//      the hallway.
// If decomposition fails, or a room cannot be solved, it falls back to a
// global push A* over the whole level with the same machinery and a weaker
// (sum of minimum distances) heuristic.
//
// Determinism: the search is budgeted by node expansions only. No wall
// clock, no randomness, no environment-dependent behaviour, so two runs
// write byte-identical output.
//
// Usage: node main.ts — reads /input/<id>/level.txt for i001..i005 and
// writes /output/<id>/solution.txt. The harness may point it elsewhere
// with MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR.

import * as fs from "node:fs";
import * as path from "node:path";

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
const IDS = ["i001", "i002", "i003", "i004", "i005"];

// Fixed move order: up, down, left, right. Used everywhere, so every
// search and every walk is deterministic.
const DIRS = [
  { dx: 0, dy: -1, ch: "u" },
  { dx: 0, dy: 1, ch: "d" },
  { dx: -1, dy: 0, ch: "l" },
  { dx: 1, dy: 0, ch: "r" },
];
const INF = 1000000000;

// ---------------------------------------------------------------- parsing

function parseLevel(text) {
  const rows = text.split("\n").filter((r) => r.length > 0);
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const wall = new Uint8Array(w * h).fill(1);
  const goal = new Uint8Array(w * h);
  const boxes = [];
  let player = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const ch = rows[y][x];
      const i = y * w + x;
      if (ch === "#") continue;
      wall[i] = 0;
      if (ch === "." || ch === "*" || ch === "+") goal[i] = 1;
      if (ch === "$" || ch === "*") boxes.push(i);
      if (ch === "@" || ch === "+") player = i;
    }
  }
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goal, boxes, player };
}

function maskOf(boxes, size) {
  const m = new Uint8Array(size);
  for (const b of boxes) m[b] = 1;
  return m;
}

// ------------------------------------------------------------ grid helpers

// All floor cells (per walkMask) reachable from `start` without stepping
// onto a box. Returns a Uint8Array visited mask.
function flood(start, boxMask, walkMask, w, h) {
  const seen = new Uint8Array(w * h);
  if (walkMask[start] === 0 || boxMask[start] === 1) return seen;
  const q = [start];
  seen[start] = 1;
  let head = 0;
  while (head < q.length) {
    const c = q[head++];
    const x = c % w;
    const y = (c / w) | 0;
    for (const d of DIRS) {
      const nx = x + d.dx;
      const ny = y + d.dy;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const n = ny * w + nx;
      if (seen[n] || walkMask[n] === 0 || boxMask[n] === 1) continue;
      seen[n] = 1;
      q.push(n);
    }
  }
  return seen;
}

// Shortest player walk from `start` to `target` (both must be floor and
// box-free), as a string of LURD moves, or null when unreachable.
function bfsPath(start, target, boxMask, walkMask, w, h) {
  if (start === target) return "";
  const prev = new Int32Array(w * h).fill(-1);
  const prevDir = new Int8Array(w * h).fill(-1);
  const q = [start];
  prev[start] = start;
  let head = 0;
  while (head < q.length) {
    const c = q[head++];
    const x = c % w;
    const y = (c / w) | 0;
    for (let di = 0; di < 4; di++) {
      const d = DIRS[di];
      const nx = x + d.dx;
      const ny = y + d.dy;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const n = ny * w + nx;
      if (prev[n] !== -1 || walkMask[n] === 0 || boxMask[n] === 1) continue;
      prev[n] = c;
      prevDir[n] = di;
      if (n === target) {
        let s = "";
        let cur = n;
        while (cur !== start) {
          s = DIRS[prevDir[cur]].ch + s;
          cur = prev[cur];
        }
        return s;
      }
      q.push(n);
    }
  }
  return null;
}

// ------------------------------------------------------- push distances
//
// For each goal, the minimum number of pushes for a lone box to reach it,
// ignoring other boxes. A box at cell b can be pushed in direction d when
// the cell behind it (b - d) is floor for the player to stand on and the
// cell ahead (b + d) is floor. Computed backwards from the goal: a box at
// b arrived from p = b - d with the player standing at b - 2d.

function pushDistances(goals, boxAllowed, walkMask, w, h) {
  const out = [];
  for (const g of goals) {
    const dist = new Int32Array(w * h).fill(INF);
    dist[g] = 0;
    const q = [g];
    let head = 0;
    while (head < q.length) {
      const b = q[head++];
      const bx = b % w;
      const by = (b / w) | 0;
      for (const d of DIRS) {
        const px = bx - d.dx;
        const py = by - d.dy;
        const sx = bx - 2 * d.dx;
        const sy = by - 2 * d.dy;
        if (px < 0 || px >= w || py < 0 || py >= h) continue;
        if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
        const p = py * w + px;
        const s = sy * w + sx;
        if (!boxAllowed[p] || walkMask[s] === 0) continue;
        if (dist[p] === INF) {
          dist[p] = dist[b] + 1;
          q.push(p);
        }
      }
    }
    out.push(dist);
  }
  return out;
}

function popcount(x) {
  let c = 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
}

// Minimum-cost assignment of boxes (in sorted order) to goals, where the
// cost of box i to goal j is the lone-box push-distance. Admissible: in
// any real solution each box needs at least its assigned distance in
// pushes, and each push moves exactly one box.
function assignmentCost(bxs, distToGoal) {
  const n = bxs.length;
  const size = 1 << n;
  const dp = new Array(size).fill(INF);
  dp[0] = 0;
  for (let mask = 0; mask < size; mask++) {
    if (dp[mask] >= INF) continue;
    const k = popcount(mask);
    if (k >= n) continue;
    const b = bxs[k];
    for (let j = 0; j < n; j++) {
      if (mask & (1 << j)) continue;
      const c = distToGoal[j][b];
      if (c >= INF) continue;
      const nm = mask | (1 << j);
      const v = dp[mask] + c;
      if (v < dp[nm]) dp[nm] = v;
    }
  }
  return dp[size - 1];
}

// ------------------------------------------------------------------- A*
//
// Push-space A*. A state is the sorted box cells plus the player's
// canonical position (the lowest-index cell of the player's reachable
// region: any two player cells reachable from each other with the same
// boxes are the same state). `weight` 1 is optimal A*; higher weights
// trade optimality for speed. `cap` bounds expansions deterministically.
// Returns { moves, pushes, endPlayer } or null.

function solvePush(cfg) {
  const { w, h, wall, goals, boxes, player, walkMask, boxAllowed } = cfg;
  const { distToGoal, weight, cap, useAssignment } = cfg;
  const n = goals.length;
  const goalSet = new Uint8Array(w * h);
  for (const g of goals) goalSet[g] = 1;
  const minDist = new Int32Array(w * h).fill(INF);
  for (let c = 0; c < w * h; c++) {
    let m = INF;
    for (let j = 0; j < n; j++) {
      const d = distToGoal[j][c];
      if (d < m) m = d;
    }
    minDist[c] = m;
  }

  function heuristic(bxs) {
    if (useAssignment) return assignmentCost(bxs, distToGoal);
    let s = 0;
    for (const b of bxs) {
      const d = minDist[b];
      if (d >= INF) return INF;
      s += d;
    }
    return s;
  }

  function solved(bxs) {
    for (const b of bxs) if (!goalSet[b]) return false;
    return true;
  }

  // A 2x2 block of only walls and boxes, holding a box that is not on a
  // goal, is frozen: none of its boxes can ever move.
  function frozenAt(nbMask, to) {
    const tx = to % w;
    const ty = (to / w) | 0;
    for (let oy = -1; oy <= 0; oy++) {
      for (let ox = -1; ox <= 0; ox++) {
        const x0 = tx + ox;
        const y0 = ty + oy;
        if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) continue;
        let allSolid = true;
        let stuckBox = false;
        for (let cy = 0; cy < 2; cy++) {
          for (let cx = 0; cx < 2; cx++) {
            const c = (y0 + cy) * w + (x0 + cx);
            if (nbMask[c]) {
              if (!goalSet[c]) stuckBox = true;
            } else if (!wall[c]) {
              allSolid = false;
            }
          }
        }
        if (allSolid && stuckBox) return true;
      }
    }
    return false;
  }

  // Binary heap ordered by (f, h, insertion order).
  const heapArr = [];
  function heapLess(a, b) {
    return a.f - b.f || a.h - b.h || a.seq - b.seq;
  }
  function heapPush(e) {
    heapArr.push(e);
    let i = heapArr.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapLess(heapArr[i], heapArr[p]) < 0) {
        const t = heapArr[i];
        heapArr[i] = heapArr[p];
        heapArr[p] = t;
        i = p;
      } else break;
    }
  }
  function heapPop() {
    const top = heapArr[0];
    const last = heapArr.pop();
    if (heapArr.length > 0) {
      heapArr[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heapArr.length && heapLess(heapArr[l], heapArr[m]) < 0) m = l;
        if (r < heapArr.length && heapLess(heapArr[r], heapArr[m]) < 0) m = r;
        if (m === i) break;
        const t = heapArr[i];
        heapArr[i] = heapArr[m];
        heapArr[m] = t;
        i = m;
      }
    }
    return top;
  }

  function finish(goalNode, nodes) {
    const chain = [];
    let cur = goalNode;
    while (cur.parent !== -1) {
      chain.push(cur);
      cur = nodes[cur.parent];
    }
    chain.reverse();
    let moves = "";
    let endPlayer = player;
    // Walks start from where the player actually stands, not from the
    // state's canonical player cell: after each push the player is on the
    // box's previous cell, which is the walk start for the next push.
    let actualPlayer = player;
    for (const p of chain) {
      const par = nodes[p.parent];
      const d = DIRS.find((dd) => dd.ch === p.dir);
      const behind = p.from - (d.dy * w + d.dx);
      const walk = bfsPath(actualPlayer, behind, maskOf(par.boxes, w * h), walkMask, w, h);
      if (walk === null) return null;
      moves += walk + p.dir;
      actualPlayer = p.from;
      endPlayer = p.from;
    }
    return { moves, pushes: chain.length, endPlayer };
  }

  const startBoxes = boxes.slice().sort((a, b) => a - b);
  const startMask = maskOf(startBoxes, w * h);
  const startReach = flood(player, startMask, walkMask, w, h);
  let startCanon = -1;
  for (let c = 0; c < w * h; c++) {
    if (startReach[c]) {
      startCanon = c;
      break;
    }
  }
  if (startCanon < 0) return null;
  const h0 = heuristic(startBoxes);
  if (h0 >= INF) return null;
  const nodes = [
    { boxes: startBoxes, player: startCanon, g: 0, h: h0, parent: -1, from: -1, to: -1, dir: "" },
  ];
  const closed = new Map();
  closed.set(startBoxes.join(",") + "|" + startCanon, 0);
  let seq = 0;
  heapPush({ f: weight * h0, h: h0, seq: seq++, idx: 0 });
  let expansions = 0;

  while (heapArr.length > 0) {
    const cur = heapPop();
    const node = nodes[cur.idx];
    const key = node.boxes.join(",") + "|" + node.player;
    if (node.g !== closed.get(key)) continue; // stale entry, superseded
    if (solved(node.boxes)) return finish(node, nodes);
    if (++expansions > cap) return null;
    const boxMask = maskOf(node.boxes, w * h);
    const reach = flood(node.player, boxMask, walkMask, w, h);
    for (let bi = 0; bi < node.boxes.length; bi++) {
      const b = node.boxes[bi];
      const bx = b % w;
      const by = (b / w) | 0;
      for (const d of DIRS) {
        const tx = bx + d.dx;
        const ty = by + d.dy;
        const hx = bx - d.dx;
        const hy = by - d.dy;
        if (tx < 0 || tx >= w || ty < 0 || ty >= h) continue;
        if (hx < 0 || hx >= w || hy < 0 || hy >= h) continue;
        const to = ty * w + tx;
        const behind = hy * w + hx;
        if (!boxAllowed[to] || boxMask[to]) continue;
        if (walkMask[behind] === 0 || !reach[behind]) continue;
        if (minDist[to] >= INF) continue; // box could never reach a goal
        const nb = node.boxes.slice();
        nb[bi] = to;
        nb.sort((a, b) => a - b);
        const nbMask = maskOf(nb, w * h);
        if (frozenAt(nbMask, to)) continue;
        const reach2 = flood(b, nbMask, walkMask, w, h);
        let canon = -1;
        for (let c = 0; c < w * h; c++) {
          if (reach2[c]) {
            canon = c;
            break;
          }
        }
        if (canon < 0) continue;
        const hh = heuristic(nb);
        if (hh >= INF) continue;
        const g = node.g + 1;
        const nkey = nb.join(",") + "|" + canon;
        const prev = closed.get(nkey);
        if (prev !== undefined && prev <= g) continue;
        closed.set(nkey, g);
        const idx = nodes.length;
        nodes.push({ boxes: nb, player: canon, g, h: hh, parent: cur.idx, from: b, to, dir: d.ch });
        heapPush({ f: g + weight * hh, h: hh, seq: seq++, idx });
      }
    }
  }
  return null;
}

// ----------------------------------------------------------- decomposition
//
// The hallway is the row the player starts in. Every other floor
// component is a room: it must hold 3-4 boxes and as many goals, and
// touch the hallway through exactly one door cell. A room whose door cell
// is itself a goal is solved last: once its box lands on the door goal,
// the player cannot leave the room.

function decompose(level) {
  const { w, h, wall, goal, boxes, player } = level;
  const hy = (player / w) | 0;
  const hall = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    const i = hy * w + x;
    if (!wall[i]) hall[i] = 1;
  }
  let goalTotal = 0;
  for (let c = 0; c < w * h; c++) if (goal[c]) goalTotal++;
  const seen = new Uint8Array(w * h);
  const rooms = [];
  for (let i = 0; i < w * h; i++) {
    if (wall[i] || hall[i] || seen[i]) continue;
    const comp = [];
    const q = [i];
    seen[i] = 1;
    let head = 0;
    while (head < q.length) {
      const c = q[head++];
      comp.push(c);
      const x = c % w;
      const y = (c / w) | 0;
      for (const d of DIRS) {
        const nx = x + d.dx;
        const ny = y + d.dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const n = ny * w + nx;
        if (seen[n] || wall[n] || hall[n]) continue;
        seen[n] = 1;
        q.push(n);
      }
    }
    const cellSet = new Set(comp);
    const rBoxes = boxes.filter((b) => cellSet.has(b));
    const rGoals = comp.filter((c) => goal[c]);
    if (rBoxes.length === 0 && rGoals.length === 0) continue; // empty pocket
    if (rBoxes.length !== rGoals.length || rBoxes.length < 3 || rBoxes.length > 4) return null;
    const doors = [];
    for (const c of comp) {
      const x = c % w;
      const y = (c / w) | 0;
      for (const d of DIRS) {
        const nx = x + d.dx;
        const ny = y + d.dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        if (hall[ny * w + nx]) {
          doors.push(c);
          break;
        }
      }
    }
    if (doors.length !== 1) return null;
    const door = doors[0];
    const entries = [];
    const dx = door % w;
    const dy = (door / w) | 0;
    for (const d of DIRS) {
      const nx = dx + d.dx;
      const ny = dy + d.dy;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      if (hall[ny * w + nx]) entries.push(ny * w + nx);
    }
    if (entries.length !== 1) return null;
    rooms.push({
      cells: comp,
      cellSet,
      boxes: rBoxes,
      goals: rGoals,
      door,
      entry: entries[0],
      doorIsGoal: goal[door] === 1,
    });
  }
  let tb = 0;
  let tg = 0;
  for (const r of rooms) {
    tb += r.boxes.length;
    tg += r.goals.length;
  }
  if (tb !== boxes.length || tg !== goalTotal) return null;
  rooms.sort((a, b) => (a.doorIsGoal - b.doorIsGoal) || (a.door - b.door));
  return { rooms };
}

// ------------------------------------------------------------ room solving

function solveRoom(level, room, weight, cap) {
  const { w, h } = level;
  const walkMask = new Uint8Array(w * h);
  for (const c of room.cells) walkMask[c] = 1;
  walkMask[room.entry] = 1;
  const boxAllowed = new Uint8Array(w * h);
  for (const c of room.cells) boxAllowed[c] = 1;
  const distToGoal = pushDistances(room.goals, boxAllowed, walkMask, w, h);
  return solvePush({
    w,
    h,
    wall: level.wall,
    goals: room.goals,
    boxes: room.boxes,
    player: room.entry,
    walkMask,
    boxAllowed,
    distToGoal,
    weight,
    cap,
    useAssignment: true,
  });
}

// ---------------------------------------------------------- global fallback

function globalSolve(level) {
  const { w, h, wall } = level;
  const goals = [];
  for (let c = 0; c < w * h; c++) if (level.goal[c]) goals.push(c);
  const walkMask = new Uint8Array(w * h);
  const boxAllowed = new Uint8Array(w * h);
  for (let c = 0; c < w * h; c++) {
    if (!wall[c]) {
      walkMask[c] = 1;
      boxAllowed[c] = 1;
    }
  }
  const distToGoal = pushDistances(goals, boxAllowed, walkMask, w, h);
  const base = {
    w,
    h,
    wall,
    goals,
    boxes: level.boxes,
    player: level.player,
    walkMask,
    boxAllowed,
    distToGoal,
    useAssignment: false,
  };
  const res =
    solvePush({ ...base, weight: 1, cap: 80000 }) ??
    solvePush({ ...base, weight: 3, cap: 80000 });
  if (!res) return "";
  const rep = replay(level, res.moves);
  if (!rep.solved || rep.illegal) return "";
  return res.moves;
}

// ------------------------------------------------------------- level solve

function solveLevel(level) {
  const dec = decompose(level);
  if (dec) {
    const allFloor = new Uint8Array(level.w * level.h);
    for (let c = 0; c < allFloor.length; c++) if (!level.wall[c]) allFloor[c] = 1;
    let moves = "";
    let curPlayer = level.player;
    let curBoxes = level.boxes.slice();
    for (const room of dec.rooms) {
      const walk = bfsPath(curPlayer, room.entry, maskOf(curBoxes, level.w * level.h), allFloor, level.w, level.h);
      if (walk === null) return globalSolve(level);
      moves += walk;
      const res =
        solveRoom(level, room, 1, 250000) ??
        solveRoom(level, room, 2, 150000) ??
        solveRoom(level, room, 4, 100000);
      if (!res) return globalSolve(level);
      moves += res.moves;
      curPlayer = res.endPlayer;
      curBoxes = curBoxes
        .filter((b) => !room.cellSet.has(b))
        .concat(room.goals)
        .sort((a, b) => a - b);
    }
    const rep = replay(level, moves);
    if (rep.solved && !rep.illegal) return moves;
    return globalSolve(level);
  }
  return globalSolve(level);
}

// ------------------------------------------------------------------- replay

function replay(level, moves) {
  const { w, h, wall, goal } = level;
  const box = new Uint8Array(w * h);
  for (const b of level.boxes) box[b] = 1;
  let px = level.player % w;
  let py = (level.player / w) | 0;
  let pushes = 0;
  for (let k = 0; k < moves.length; k++) {
    const d = DIRS.find((dd) => dd.ch === moves[k]);
    if (!d) return { illegal: true, solved: false, pushes };
    const nx = px + d.dx;
    const ny = py + d.dy;
    if (nx < 0 || nx >= w || ny < 0 || ny >= h) return { illegal: true, solved: false, pushes };
    const next = ny * w + nx;
    if (wall[next]) return { illegal: true, solved: false, pushes };
    if (box[next]) {
      const bx = nx + d.dx;
      const by = ny + d.dy;
      if (bx < 0 || bx >= w || by < 0 || by >= h) return { illegal: true, solved: false, pushes };
      const beyond = by * w + bx;
      if (wall[beyond] || box[beyond]) return { illegal: true, solved: false, pushes };
      box[next] = 0;
      box[beyond] = 1;
      pushes++;
    }
    px = nx;
    py = ny;
  }
  for (let c = 0; c < box.length; c++) {
    if (box[c] && !goal[c]) return { illegal: false, solved: false, pushes };
  }
  return { illegal: false, solved: true, pushes };
}

// --------------------------------------------------------------------- main

function main() {
  for (const id of IDS) {
    let moves = "";
    try {
      const text = fs.readFileSync(path.join(INPUT_DIR, id, "level.txt"), "utf8");
      const level = parseLevel(text);
      moves = solveLevel(level);
      if (replay(level, moves).illegal) moves = "";
    } catch (e) {
      moves = "";
    }
    const outDir = path.join(OUTPUT_DIR, id);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "solution.txt"), moves, "utf8");
  }
}

main();
