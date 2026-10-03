import { DurableObject } from "cloudflare:workers";
import {
  advance, createRoom, drawCard, nextDue, press, publicRoom, startMatch, startRound,
  type Card, type Player, type RoomState,
} from "../shared/game";

type Env = { ROOMS: DurableObjectNamespace<GameRoom>; ASSETS: Fetcher };
const ROOM_LIFETIME_MS = 24 * 60 * 60 * 1000;
const RECONNECT_MS = 30_000;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function cleanName(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 20) : "";
}

function cleanCards(value: unknown): Card[] {
  if (!Array.isArray(value)) return [];
  const used = new Set<string>();
  return value.slice(0, 40).flatMap((item) => {
    const text = typeof item === "string" ? item.trim().slice(0, 120) : "";
    if (!text || used.has(text)) return [];
    used.add(text);
    return [{ id: crypto.randomUUID(), text }];
  });
}

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join("");
}

function member(name: string, seat: number, now: number): Player {
  return { id: crypto.randomUUID(), token: crypto.randomUUID(), name, seat, joinedAt: now };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (request.method === "POST" && url.pathname === "/api/rooms") {
      const body = await request.json().catch(() => ({})) as { name?: unknown; cards?: unknown };
      const name = cleanName(body.name);
      if (!name) return json({ error: "名前を入力してください。" }, 400);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const code = randomCode();
        const stub = env.ROOMS.getByName(code);
        const response = await stub.fetch("https://room.internal/init", {
          method: "POST", body: JSON.stringify({ code, name, cards: body.cards }),
        });
        if (response.status !== 409) return response;
      }
      return json({ error: "部屋を作れませんでした。もう一度お試しください。" }, 503);
    }
    const match = /^\/api\/rooms\/([A-Z2-9]{8})\/(join|socket|leave)$/.exec(url.pathname);
    if (!match) return json({ error: "見つかりません。" }, 404);
    const [, code, action] = match;
    if ((action === "join" || action === "leave") && request.method !== "POST") return json({ error: "操作できません。" }, 405);
    if (action === "socket" && request.method !== "GET") return json({ error: "操作できません。" }, 405);
    const stub = env.ROOMS.getByName(code);
    if (action === "join" || action === "leave") {
      return stub.fetch(new Request(`https://room.internal/${action}`, { method: "POST", body: request.body, headers: request.headers }));
    }
    return stub.fetch(new Request(`https://room.internal/socket?token=${encodeURIComponent(url.searchParams.get("token") ?? "")}`, { headers: request.headers }));
  },
} satisfies ExportedHandler<Env>;

export class GameRoom extends DurableObject<Env> {
  private async load(): Promise<RoomState | null> {
    const room = await this.ctx.storage.get<RoomState>("room") ?? null;
    if (room) room.messages ??= [];
    return room;
  }

  private async removePlayer(room: RoomState, id: string, now: number): Promise<void> {
    room.players = room.players.filter((player) => player.id !== id);
    for (const socket of this.ctx.getWebSockets(id)) socket.close(4002, "left room");
    if (!room.players.length) {
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if (!room.players.some((player) => player.id === room.hostId)) room.hostId = [...room.players].sort((a, b) => a.joinedAt - b.joinedAt)[0].id;
    this.updateHost(room);
    if (["active", "countdown", "paused"].includes(room.phase)) {
      if (this.missing(room).length) {
        room.phase = "paused"; room.pauseUntil = now + RECONNECT_MS;
        room.goAt = null; room.pending = []; room.cpuTimes = []; room.safeCalls = [];
      } else startRound(room, now, false, true);
    }
    room.updatedAt = now;
    await this.save(room);
    this.broadcast(room);
  }

  private connected(id: string): boolean {
    return this.ctx.getWebSockets(id).some((socket) => socket.readyState === WebSocket.OPEN);
  }

  private missing(room: RoomState): Player[] {
    return room.players.filter((player) => !this.connected(player.id));
  }

  private async save(room: RoomState): Promise<void> {
    await this.ctx.storage.put("room", room);
    const now = Date.now();
    const events = [nextDue(room), room.pauseUntil, room.updatedAt + ROOM_LIFETIME_MS,
      ...room.players.map((player) => player.disconnectedAt ? player.disconnectedAt + RECONNECT_MS : null)]
      .filter((value): value is number => value !== null && Number.isFinite(value) && value > now);
    if (events.length) await this.ctx.storage.setAlarm(Math.min(...events));
  }

  private broadcast(room: RoomState): void {
    const message = JSON.stringify({ type: "snapshot", room: publicRoom(room), serverNow: Date.now() });
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState === WebSocket.OPEN) {
        try { socket.send(message); } catch { /* socket is closing */ }
      }
    }
  }

  private updateHost(room: RoomState): void {
    if (this.connected(room.hostId)) return;
    const replacement = room.players.filter((player) => this.connected(player.id)).sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (replacement) room.hostId = replacement.id;
  }

  private maintain(room: RoomState, now: number): boolean {
    let changed = advance(room, now);
    if (room.phase === "lobby") {
      const before = room.players.length;
      room.players = room.players.filter((player) => !player.disconnectedAt || player.disconnectedAt + RECONNECT_MS > now);
      if (room.players.length !== before) {
        this.updateHost(room);
        changed = true;
      }
    }
    if (room.phase === "paused") {
      if (this.missing(room).length === 0) {
        startRound(room, now, false, true);
        changed = true;
      } else if (room.pauseUntil !== null && now >= room.pauseUntil) {
        room.pauseUntil = null;
        this.updateHost(room);
        changed = true;
      }
    }
    const host = room.players.find((player) => player.id === room.hostId);
    if (host?.disconnectedAt && host.disconnectedAt + RECONNECT_MS <= now) {
      const previous = room.hostId;
      this.updateHost(room);
      changed ||= room.hostId !== previous;
    }
    if (changed) room.updatedAt = now;
    return changed;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const now = Date.now();
    if (url.pathname === "/init" && request.method === "POST") {
      const existing = await this.load();
      if (existing && existing.updatedAt + ROOM_LIFETIME_MS > now) return json({ error: "部屋コードが重複しました。" }, 409);
      const input = await request.json() as { code: string; name: string; cards?: unknown };
      const host = member(input.name, 0, now);
      const room = createRoom(input.code, host, cleanCards(input.cards), now);
      await this.save(room);
      return json({ code: input.code, memberId: host.id, token: host.token });
    }
    const room = await this.load();
    if (!room || room.updatedAt + ROOM_LIFETIME_MS <= now) return json({ error: "部屋が見つからないか、期限切れです。" }, 404);
    if (this.maintain(room, now)) {
      if (!room.players.length) { await this.ctx.storage.deleteAll(); await this.ctx.storage.deleteAlarm(); return json({ error: "部屋は終了しました。" }, 404); }
      await this.save(room);
      this.broadcast(room);
    }
    if (url.pathname === "/leave" && request.method === "POST") {
      const input = await request.json().catch(() => ({})) as { token?: string };
      const player = room.players.find((item) => item.token === input.token);
      if (!player) return json({ error: "参加情報が無効です。" }, 403);
      await this.removePlayer(room, player.id, now);
      return json({ ok: true });
    }
    if (url.pathname === "/join" && request.method === "POST") {
      if (room.phase !== "lobby") return json({ error: "対戦中のため参加できません。" }, 409);
      const input = await request.json().catch(() => ({})) as { name?: unknown };
      const name = cleanName(input.name);
      if (!name) return json({ error: "名前を入力してください。" }, 400);
      const used = new Set(room.players.map((player) => player.seat));
      const seat = Array.from({ length: 6 }, (_, i) => i).find((i) => !used.has(i));
      if (seat === undefined) return json({ error: "この部屋は満員です。" }, 409);
      const player = member(name, seat, now);
      room.players.push(player);
      if (!room.players.some((item) => item.id === room.hostId)) room.hostId = player.id;
      room.updatedAt = now;
      await this.save(room);
      this.broadcast(room);
      return json({ code: room.code, memberId: player.id, token: player.token });
    }
    if (url.pathname === "/socket") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ error: "WebSocketが必要です。" }, 426);
      const player = room.players.find((item) => item.token === url.searchParams.get("token"));
      if (!player) return json({ error: "参加情報が無効です。" }, 403);
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      for (const old of this.ctx.getWebSockets(player.id)) old.close(4000, "new connection");
      this.ctx.acceptWebSocket(server, [player.id]);
      server.serializeAttachment({ memberId: player.id });
      player.disconnectedAt = undefined;
      room.updatedAt = now;
      this.maintain(room, now);
      await this.save(room);
      this.broadcast(room);
      return new Response(null, { status: 101, webSocket: client });
    }
    return json({ error: "見つかりません。" }, 404);
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const room = await this.load();
    if (!room) return;
    const now = Date.now();
    const id = (socket.deserializeAttachment() as { memberId?: string } | null)?.memberId;
    const player = room.players.find((item) => item.id === id);
    if (!player) return;
    let changed = this.maintain(room, now);
    let command: { type?: string; text?: unknown; id?: unknown; enabled?: unknown; collisionMs?: unknown; target?: unknown; signal?: unknown };
    try { command = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)); }
    catch { return; }
    if (!command || typeof command !== "object") return;
    const host = player.id === room.hostId;
    switch (command.type) {
      case "leave":
        await this.removePlayer(room, player.id, now); return;
      case "setCollision":
        if (host && room.phase === "lobby" && [200, 300, 500].includes(command.collisionMs as number)) {
          room.collisionMs = command.collisionMs as RoomState["collisionMs"]; changed = true;
        }
        break;
      case "chat": {
        const text = typeof command.text === "string" ? command.text.trim().slice(0, 200) : "";
        const last = room.messages.filter((item) => item.memberId === player.id).at(-1);
        if (text && (!last || now - last.at >= 1000)) {
          room.messages.push({ id: crypto.randomUUID(), memberId: player.id, name: player.name, text, at: now });
          room.messages = room.messages.slice(-50); changed = true;
        }
        break;
      }
      case "voiceReady":
        for (const target of this.ctx.getWebSockets()) if (target.readyState === WebSocket.OPEN) target.send(JSON.stringify({ type: "voiceReset", from: player.id }));
        break;
      case "voiceSignal": {
        if (typeof command.target !== "string" || command.target === player.id || !room.players.some((item) => item.id === command.target) || !command.signal || typeof command.signal !== "object" || (JSON.stringify(command.signal) ?? "").length > 20_000) break;
        for (const target of this.ctx.getWebSockets(command.target)) {
          if (target.readyState === WebSocket.OPEN) target.send(JSON.stringify({ type: "voiceSignal", from: player.id, signal: command.signal }));
        }
        break;
      }
      case "voiceState":
        for (const target of this.ctx.getWebSockets()) if (target.readyState === WebSocket.OPEN) target.send(JSON.stringify({ type: "voiceState", from: player.id, talking: command.enabled === true }));
        break;
      case "start":
        if (host && room.players.every((item) => this.connected(item.id)) && startMatch(room, now)) changed = true;
        break;
      case "next":
        if (host && room.phase === "result") { startRound(room, now, false); changed = true; }
        break;
      case "call":
        if (press(room, player.seat, now)) changed = true;
        break;
      case "setMode":
        if (host && room.phase === "lobby" && typeof command.enabled === "boolean") {
          room.penaltyEnabled = command.enabled; changed = true;
        }
        break;
      case "addCard": {
        const text = typeof command.text === "string" ? command.text.trim().slice(0, 120) : "";
        if (room.phase === "lobby" && text && room.cards.length < 40 && !room.cards.some((card) => card.text === text)) {
          room.cards.push({ id: crypto.randomUUID(), text }); changed = true;
        }
        break;
      }
      case "deleteCard":
        if (room.phase === "lobby" && typeof command.id === "string") {
          const before = room.cards.length;
          room.cards = room.cards.filter((card) => card.id !== command.id);
          changed ||= room.cards.length !== before;
        }
        break;
      case "draw":
        if (!room.draws[player.id] && drawCard(room, player.id)) changed = true;
        break;
      case "redraw":
        if (room.draws[player.id] && drawCard(room, player.id)) changed = true;
        break;
      case "resumeCpu":
        if (host && room.phase === "paused" && room.pauseUntil === null) {
          room.players = room.players.filter((item) => this.connected(item.id));
          if (room.players.length) { startRound(room, now, false, true); changed = true; }
        }
        break;
      case "abort":
        if (host && room.phase === "paused" && room.pauseUntil === null) {
          room.players = room.players.filter((item) => this.connected(item.id));
          room.phase = "lobby"; room.round = 0; room.scores = Array(6).fill(0);
          room.pauseUntil = null; room.goAt = null; room.pending = []; room.cpuTimes = [];
          changed = true;
        }
        break;
      case "newGame":
        if (host && room.phase === "finished") {
          room.phase = "lobby"; room.round = 0; room.scores = Array(6).fill(0);
          room.draws = {}; room.deck = []; room.losers = []; room.dobons = [];
          room.players = room.players.filter((item) => this.connected(item.id));
          changed = true;
        }
        break;
    }
    if (changed) {
      room.updatedAt = now;
      await this.save(room);
      this.broadcast(room);
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    const room = await this.load();
    if (!room) return;
    const id = (socket.deserializeAttachment() as { memberId?: string } | null)?.memberId;
    const player = room.players.find((item) => item.id === id);
    if (!player || this.connected(player.id)) return;
    const now = Date.now();
    player.disconnectedAt = now;
    if (room.phase === "countdown" || room.phase === "active") {
      room.phase = "paused";
      room.pauseUntil = now + RECONNECT_MS;
      room.goAt = null; room.pending = []; room.safeCalls = []; room.cpuTimes = [];
    }
    room.updatedAt = now;
    await this.save(room);
    this.broadcast(room);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    await this.webSocketClose(socket);
  }

  async alarm(): Promise<void> {
    const room = await this.load();
    if (!room) return;
    const now = Date.now();
    if (room.updatedAt + ROOM_LIFETIME_MS <= now) {
      for (const socket of this.ctx.getWebSockets()) socket.close(4001, "room expired");
      await this.ctx.storage.delete("room");
      return;
    }
    const changed = this.maintain(room, now);
    if (!room.players.length) { await this.ctx.storage.deleteAll(); await this.ctx.storage.deleteAlarm(); return; }
    await this.save(room);
    if (changed) this.broadcast(room);
  }
}
