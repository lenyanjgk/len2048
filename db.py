# -*- coding: utf-8 -*-
"""
对局记录持久层 —— Python 标准库 sqlite3，零第三方依赖。

作者：lenyanjgk（冷颜） · 2048 AI Web Assistant · MIT

两张表：

  games  一行 = 一局。存这局的元数据 + 当前/最终局面（board 是 4x4 JSON）。
         死局、进行中都在这张表里，用 is_over 区分；updated_at 一直往前推，
         所以"当前进行中的局"永远是每个 mode 下最近更新的那一行。
  moves  一行 = 一步。着法流水，带每一步走完后的盘面，可逐布回放。
         game_id 外键 + ON DELETE CASCADE，删一局就连着删它的着法。

连接按线程各自持有（ThreadingHTTPServer 每请求一个线程），
sqlite3 连接不能跨线程共用，所以用 threading.local。
"""

import json
import os
import sqlite3
import threading
from datetime import datetime

import ai2048

# 测试可用 LEN2048_DB 指向临时库，避免污染正式的 games.db
DB_PATH = os.environ.get(
    "LEN2048_DB",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "games.db"))

MAX_TILE_LIMIT = 1 << ai2048.MAX_RANK   # 32768，超过会撑爆 nibble

# 引擎内部用英文名，落库统一成中文（管理页直接显示，不再做一层映射）
MOVE_NAMES = {0: "上", 1: "下", 2: "左", 3: "右"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS games (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    mode        TEXT    NOT NULL DEFAULT 'assistant',
    score       INTEGER NOT NULL DEFAULT 0,
    max_tile    INTEGER NOT NULL DEFAULT 0,
    moves       INTEGER NOT NULL DEFAULT 0,
    elapsed_ms  INTEGER NOT NULL DEFAULT 0,
    is_over     INTEGER NOT NULL DEFAULT 0,
    board       TEXT    NOT NULL DEFAULT '[]',
    note        TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL,
    ended_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_games_updated ON games(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_games_mode    ON games(mode, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_games_over    ON games(is_over, updated_at DESC);

CREATE TABLE IF NOT EXISTS moves (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id        INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    step_no        INTEGER NOT NULL,
    direction      INTEGER NOT NULL,
    direction_name TEXT    NOT NULL,
    gain           INTEGER NOT NULL DEFAULT 0,
    score_after    INTEGER NOT NULL DEFAULT 0,
    board_after    TEXT    NOT NULL DEFAULT '[]',
    source         TEXT    NOT NULL DEFAULT 'manual',
    created_at     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moves_game ON moves(game_id, step_no);
"""

_local = threading.local()


def now_iso():
    """本地时间 ISO 字符串（带时区偏移），管理页直接显示即可读。"""
    return datetime.now().astimezone().isoformat(timespec="seconds")


def conn():
    """当前线程的 sqlite 连接（懒创建）。"""
    c = getattr(_local, "c", None)
    if c is None:
        c = sqlite3.connect(DB_PATH, timeout=10.0)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA foreign_keys = ON")
        c.execute("PRAGMA journal_mode = WAL")   # 读写不互斥，管理页读时应用还能写
        _local.c = c
    return c


def init_db():
    with conn() as c:
        c.executescript(SCHEMA)


def close_db():
    c = getattr(_local, "c", None)
    if c is not None:
        c.close()
        _local.c = None


# ---------------------------------------------------------------- 校验

def validate_board(matrix):
    """校验并规范化 4x4 棋盘：只允许 0 或 2 的幂（2 ~ 32768）。
    注意 1 虽然是 2 的 0 次方，但 2048 里最小块是 2，必须拒掉。"""
    if not isinstance(matrix, list) or len(matrix) != 4:
        raise ValueError("board 必须是 4x4 矩阵")
    out = []
    for row in matrix:
        if not isinstance(row, list) or len(row) != 4:
            raise ValueError("board 必须是 4x4 矩阵")
        new_row = []
        for v in row:
            v = int(v)
            if v != 0 and (v < 2 or (v & (v - 1)) != 0):
                raise ValueError(f"棋盘数值必须是 2 的幂或 0，收到 {v}")
            if v > MAX_TILE_LIMIT:
                raise ValueError(f"棋盘数值不能超过 {MAX_TILE_LIMIT}")
            new_row.append(v)
        out.append(new_row)
    return out


def board_max_tile(matrix):
    m = 0
    for row in matrix:
        for v in row:
            if v > m:
                m = v
    return m


def _as_board(matrix):
    """入库用的 JSON 文本；非法就报错，绝不静默写坏数据。"""
    return json.dumps(validate_board(matrix), separators=(",", ":"))


# ---------------------------------------------------------------- games

def create_game(mode, board, score=0, moves=0, elapsed_ms=0, note=""):
    matrix = validate_board(board)
    ts = now_iso()
    with conn() as c:
        cur = c.execute(
            "INSERT INTO games (mode, score, max_tile, moves, elapsed_ms, is_over,"
            "                 board, note, created_at, updated_at)"
            " VALUES (?,?,?,?,?,0,?,?,?,?)",
            (mode if mode in ("assistant", "free") else "assistant",
             max(0, int(score)), board_max_tile(matrix), max(0, int(moves)),
             max(0, int(elapsed_ms)), _as_board(matrix), str(note)[:200], ts, ts))
        return cur.lastrowid


def update_game(game_id, board=None, score=None, moves=None, elapsed_ms=None,
                is_over=None, note=None):
    """局部更新一局。只更新传了的字段，避免并发把别的字段清掉。"""
    fields, args = [], []
    if board is not None:
        matrix = validate_board(board)
        fields.append("board = ?")
        args.append(_as_board(matrix))
        fields.append("max_tile = ?")
        args.append(board_max_tile(matrix))
    if score is not None:
        fields.append("score = ?")
        args.append(max(0, int(score)))
    if moves is not None:
        fields.append("moves = ?")
        args.append(max(0, int(moves)))
    if elapsed_ms is not None:
        fields.append("elapsed_ms = ?")
        args.append(max(0, int(elapsed_ms)))
    if is_over is not None:
        fields.append("is_over = ?")
        args.append(1 if is_over else 0)
        fields.append("ended_at = ?")
        args.append(now_iso() if is_over else None)
    if note is not None:
        fields.append("note = ?")
        args.append(str(note)[:200])
    if not fields:
        return get_game(game_id)
    fields.append("updated_at = ?")
    args.append(now_iso())
    args.append(game_id)
    with conn() as c:
        c.execute(f"UPDATE games SET {', '.join(fields)} WHERE id = ?", args)
    return get_game(game_id)


def get_game(game_id):
    row = conn().execute("SELECT * FROM games WHERE id = ?", (game_id,)).fetchone()
    return dict(row) if row else None


def list_games(mode=None, is_over=None, limit=50, offset=0, order="updated"):
    """按条件列对局。order: updated | score | moves"""
    where, args = [], []
    if mode in ("assistant", "free"):
        where.append("mode = ?")
        args.append(mode)
    if is_over is not None:
        where.append("is_over = ?")
        args.append(1 if is_over else 0)
    sql_where = (" WHERE " + " AND ".join(where)) if where else ""
    order_sql = {
        "updated": "updated_at DESC, id DESC",
        "score": "score DESC, id DESC",
        "moves": "moves DESC, id DESC",
    }.get(order, "updated_at DESC, id DESC")
    c = conn()
    total = c.execute(f"SELECT COUNT(*) AS n FROM games{sql_where}", args).fetchone()["n"]
    rows = c.execute(
        f"SELECT * FROM games{sql_where} ORDER BY {order_sql} LIMIT ? OFFSET ?",
        args + [max(1, min(200, int(limit))), max(0, int(offset))]).fetchall()
    return [dict(r) for r in rows], total


def delete_game(game_id):
    with conn() as c:
        cur = c.execute("DELETE FROM games WHERE id = ?", (game_id,))
        return cur.rowcount > 0


# ---------------------------------------------------------------- moves

def add_move(game_id, direction, gain=0, score_after=0, board_after=None,
             source="manual"):
    if direction not in (0, 1, 2, 3):
        raise ValueError("direction 必须是 0/1/2/3")
    if source not in ("manual", "ai", "autoshift"):
        source = "manual"
    c = conn()
    row = c.execute("SELECT COUNT(*) AS n, COALESCE(MAX(step_no),0) AS mx"
                    " FROM moves WHERE game_id = ?", (game_id,)).fetchone()
    step_no = row["mx"] + 1
    ts = now_iso()
    with c:
        cur = c.execute(
            "INSERT INTO moves (game_id, step_no, direction, direction_name, gain,"
            "                 score_after, board_after, source, created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (game_id, step_no, direction, MOVE_NAMES[direction], max(0, int(gain)),
             max(0, int(score_after)), _as_board(board_after or []), source, ts))
    return cur.lastrowid, step_no


def list_moves(game_id):
    rows = conn().execute(
        "SELECT * FROM moves WHERE game_id = ? ORDER BY step_no", (game_id,)).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------- 汇总

def summary():
    """管理页顶部那几个数。全部由 SQL 现算，不落冗余字段。

    total_moves   = 各局记分板步数之和（games.moves，人工/自动都可能写）
    logged_moves  = 着法流水行数（moves 表，只有真正走了并记了流的才算）
    正常情况下两者相等；不想等说明有局只更新了元数据没记流水，两个都报出来更诚实。
    """
    c = conn()
    g = c.execute(
        "SELECT COUNT(*) AS games,"
        "       COALESCE(SUM(score),0) AS total_score,"
        "       COALESCE(MAX(score),0) AS best_score,"
        "       COALESCE(MAX(max_tile),0) AS best_tile,"
        "       COALESCE(SUM(moves),0) AS total_moves,"
        "       COALESCE(SUM(is_over),0) AS over_games,"
        "       COALESCE(SUM(elapsed_ms),0) AS total_ms"
        " FROM games").fetchone()
    m = c.execute("SELECT COUNT(*) AS moves FROM moves").fetchone()
    by_mode = {r["mode"]: r["n"] for r in c.execute(
        "SELECT mode, COUNT(*) AS n FROM games GROUP BY mode")}
    return {
        "games": g["games"],
        "over_games": g["over_games"],
        "live_games": g["games"] - g["over_games"],
        "total_score": g["total_score"],
        "best_score": g["best_score"],
        "best_tile": g["best_tile"],
        "total_moves": g["total_moves"],
        "logged_moves": m["moves"],
        "total_ms": g["total_ms"],
        "by_mode": by_mode,
    }
