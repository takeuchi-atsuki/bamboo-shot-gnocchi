export const SEATS = 6;
export const COLLISION_MS = 500;
export const IDLE_MS = 15_000;
export const FIRST_COUNTDOWN_MS = 7_000;
export const NEXT_COUNTDOWN_MS = 4_000;

export type Phase = "lobby" | "countdown" | "active" | "result" | "finished" | "paused";
export type ResultReason = "collision" | "last" | "flying" | "timeout";
export type Player = {
  id: string;
  token: string;
  name: string;
  seat: number;
  joinedAt: number;
  disconnectedAt?: number;
};
export type Card = { id: string; text: string };
export type Call = { seat: number; number: number };
export type TimedSeat = { seat: number; at: number };
export type RoomState = {
  code: string;
  hostId: string;
  players: Player[];
  phase: Phase;
  round: number;
  scores: number[];
  penaltyEnabled: boolean;
  cards: Card[];
  goAt: number | null;
  lastProgressAt: number | null;
  pending: TimedSeat[];
  safeCalls: Call[];
  cpuTimes: TimedSeat[];
  dobons: number[];
  losers: number[];
  reason: ResultReason | null;
  pauseUntil: number | null;
  draws: Record<string, string>;
  deck: string[];
  updatedAt: number;
};

export type PublicRoom = Omit<RoomState, "players" | "pending" | "cpuTimes" | "deck"> & {
  players: Omit<Player, "token">[];
  pendingSeats: number[];
};

export function createRoom(code: string, host: Player, cards: Card[], now: number): RoomState {
  return {
    code, hostId: host.id, players: [host], phase: "lobby", round: 0,
    scores: Array(SEATS).fill(0), penaltyEnabled: false, cards,
    goAt: null, lastProgressAt: null, pending: [], safeCalls: [], cpuTimes: [],
    dobons: [], losers: [], reason: null, pauseUntil: null, draws: {}, deck: [], updatedAt: now,
  };
}

export function publicRoom(room: RoomState): PublicRoom {
  const { players, pending, cpuTimes: _cpuTimes, deck: _deck, ...rest } = room;
  return {
    ...rest,
    players: players.map(({ token: _token, ...player }) => player),
    pendingSeats: pending.map((item) => item.seat),
  };
}

export function cpuSeats(room: RoomState): number[] {
  const occupied = new Set(room.players.map((player) => player.seat));
  return Array.from({ length: SEATS }, (_, i) => i).filter((seat) => !occupied.has(seat));
}

export function startRound(room: RoomState, now: number, first: boolean, retry = false): void {
  if (!retry) room.round += 1;
  room.phase = "countdown";
  room.goAt = now + (first ? FIRST_COUNTDOWN_MS : NEXT_COUNTDOWN_MS);
  room.lastProgressAt = null;
  room.pending = [];
  room.safeCalls = [];
  room.cpuTimes = [];
  room.dobons = [];
  room.losers = [];
  room.reason = null;
  room.pauseUntil = null;
  room.updatedAt = now;
}

export function startMatch(room: RoomState, now: number): boolean {
  if (room.phase !== "lobby" || room.players.length === 0) return false;
  if (room.penaltyEnabled && room.cards.length === 0) return false;
  room.scores = Array(SEATS).fill(0);
  room.round = 0;
  room.draws = {};
  room.deck = [];
  startRound(room, now, true);
  return true;
}

export function shuffle<T>(values: T[], random = Math.random): T[] {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function endRound(room: RoomState, seats: number[], reason: ResultReason, now: number, random: () => number): void {
  const dobons = [...new Set(seats)];
  for (const seat of dobons) room.scores[seat] += 1;
  const three = dobons.some((seat) => room.scores[seat] >= 3);
  room.losers = reason === "collision" && three
    ? dobons
    : dobons.filter((seat) => room.scores[seat] >= 3);
  room.dobons = dobons;
  room.reason = reason;
  room.phase = room.losers.length ? "finished" : "result";
  room.pending = [];
  room.cpuTimes = [];
  room.goAt = null;
  room.lastProgressAt = null;
  room.deck = room.phase === "finished" ? shuffle(room.cards.map((card) => card.id), random) : [];
  room.updatedAt = now;
}

export function press(room: RoomState, seat: number, now: number, random = Math.random): boolean {
  if (!Number.isInteger(seat) || seat < 0 || seat >= SEATS) return false;
  if (room.phase === "countdown" && room.goAt !== null && now < room.goAt) {
    endRound(room, [seat], "flying", now, random);
    return true;
  }
  if (room.phase !== "active") return false;
  if (room.safeCalls.some((call) => call.seat === seat) || room.pending.some((call) => call.seat === seat)) return false;
  room.pending.push({ seat, at: now });
  room.updatedAt = now;
  return true;
}

function resolvePending(room: RoomState, at: number, random: () => number): void {
  const pending = room.pending;
  room.pending = [];
  if (pending.length > 1) {
    endRound(room, pending.map((item) => item.seat), "collision", at, random);
    return;
  }
  const seat = pending[0].seat;
  room.safeCalls.push({ seat, number: room.safeCalls.length + 1 });
  room.lastProgressAt = at;
  room.updatedAt = at;
  if (room.safeCalls.length === SEATS - 1) {
    const called = new Set(room.safeCalls.map((call) => call.seat));
    endRound(room, Array.from({ length: SEATS }, (_, i) => i).filter((i) => !called.has(i)), "last", at, random);
  }
}

export function advance(room: RoomState, now: number, random = Math.random): boolean {
  let changed = false;
  for (let guard = 0; guard < 32; guard += 1) {
    if (room.phase === "countdown" && room.goAt !== null && room.goAt <= now) {
      room.phase = "active";
      room.lastProgressAt = room.goAt;
      room.cpuTimes = shuffle(cpuSeats(room), random).map((seat, index) => ({
        seat,
        at: room.goAt! + 900 + index * 2000 + Math.floor(random() * 1400),
      }));
      room.updatedAt = room.goAt;
      changed = true;
      continue;
    }
    if (room.phase !== "active") break;
    const pendingEnd = room.pending.length ? room.pending[0].at + COLLISION_MS + 1 : Infinity;
    const cpuAt = Math.min(...room.cpuTimes.map((event) => event.at), Infinity);
    const idleAt = room.pending.length ? Infinity : (room.lastProgressAt ?? now) + IDLE_MS;
    const next = Math.min(pendingEnd, cpuAt, idleAt);
    if (next > now) break;
    if (cpuAt === next) {
      const due = room.cpuTimes.filter((event) => event.at === next);
      room.cpuTimes = room.cpuTimes.filter((event) => event.at !== next);
      for (const event of due) press(room, event.seat, next, random);
    } else if (pendingEnd === next) {
      resolvePending(room, next, random);
    } else {
      const called = new Set([...room.safeCalls.map((call) => call.seat), ...room.pending.map((call) => call.seat)]);
      endRound(room, Array.from({ length: SEATS }, (_, i) => i).filter((i) => !called.has(i)), "timeout", next, random);
    }
    changed = true;
  }
  return changed;
}

export function nextDue(room: RoomState): number | null {
  if (room.phase === "countdown") return room.goAt;
  if (room.phase === "active") {
    return Math.min(
      room.pending.length ? room.pending[0].at + COLLISION_MS + 1 : Infinity,
      ...room.cpuTimes.map((event) => event.at),
      room.pending.length ? Infinity : (room.lastProgressAt ?? Date.now()) + IDLE_MS,
    );
  }
  return null;
}

export function drawCard(room: RoomState, memberId: string, random = Math.random): string | null {
  if (room.phase !== "finished" || !room.penaltyEnabled) return null;
  const player = room.players.find((item) => item.id === memberId);
  if (!player || !room.losers.includes(player.seat) || room.cards.length === 0) return null;
  const previous = room.draws[memberId];
  if (room.deck.length === 0) room.deck = shuffle(room.cards.map((card) => card.id).filter((id) => id !== previous), random);
  if (room.deck.length === 0) return null;
  const cardId = room.deck.shift()!;
  room.draws[memberId] = cardId;
  return cardId;
}
