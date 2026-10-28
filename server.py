# -*- coding: utf-8 -*-
"""
2048 AI 网页服务 —— Python 标准库 http.server，零第三方依赖。

作者：lenyanjgk（冷颜） · 2048 AI Web Assistant · MIT

用法：
    python server.py            # 默认 http://127.0.0.1:8765 ，自动打开浏览器
    python server.py --port 9000 --no-browser

API（POST，JSON）：
    /api/best_move   {board:[[4x4]], depth_mode, fixed_depth, max_depth, time_budget_ms}
                    -> {best, best_name, arrow, scores, valid_moves, game_over, board_after, stats}
    /api/auto        {board, max_steps, ...同上搜索参数}
                    -> {steps:[{move,score,board,...}], final_score, max_tile, game_over}
    /api/simulate    {games, seed, ...同上搜索参数}
                    -> {games, mean_score, max_score, min_score, tile_dist, results}
    /api/games       {mode, board, score, moves, elapsed_ms, note}  -> {id}   新建一局
    /api/games/upd   {id, ...同上, is_over}                          -> 该局   局部更新
    /api/games/move  {id, direction, gain, score_after, board_after, source} -> {step_no}
    /api/games/del   {id}                                            -> {deleted}

对局记录（GET，JSON）：
    /admin                 -> 管理页
    /api/games?mode=&is_over=&order=&limit=&offset=  -> {games:[...], total}
    /api/games/<id>        -> {game, moves:[...]}
    /api/games/summary     -> {games, over_games, best_score, best_tile, ...}

静态文件：static/index.html / app.js / style.css
数据库：games.db（SQLite，schema 见 db.py）
"""

import json
import os
import sys
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import ai2048
import db

# 端口优先取环境变量，其次命令行 --port，最后默认值
DEFAULT_PORT = int(os.environ.get("PORT", "8765"))

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")


# ---------------------------------------------------------------- 工具

def validate_board(matrix):
    return db.validate_board(matrix)


def parse_search_params(payload):
    """从请求体解析搜索参数（带范围钳制）。
    注意 time_budget_ms == 0 表示「不限时长」（无死线，搜到目标深度为止）。"""
    def clamp(name, lo, hi, default, cast=int):
        v = payload.get(name, default)
        try:
            v = cast(v)
        except (TypeError, ValueError):
            v = default
        return max(lo, min(hi, v))

    try:
        budget = int(payload.get("time_budget_ms", 3000))
    except (TypeError, ValueError):
        budget = 3000
    if budget != 0:                      # 0 放行；其余限制在 50ms ~ 60s
        budget = max(50, min(60000, budget))

    return {
        "depth_mode": "fixed" if payload.get("depth_mode") == "fixed" else "adaptive",
        "fixed_depth": clamp("fixed_depth", 1, 10, 4),
        "max_depth": clamp("max_depth", 1, 12, 8),
        "prob_thresh": clamp("prob_thresh", 1e-8, 0.01, ai2048.CPROB_THRESH_BASE, float),
        "time_budget_ms": budget,
    }


def board_after_move(board_matrix, move):
    """前端预览：执行移动但不放新块"""
    b = ai2048.matrix_to_board(board_matrix)
    return ai2048.board_to_matrix(ai2048.execute_move(move, b))


# ---------------------------------------------------------------- API 处理

def api_best_move(payload):
    matrix = validate_board(payload.get("board"))
    opts = parse_search_params(payload)
    board = ai2048.matrix_to_board(matrix)
    valid = ai2048.get_valid_moves(board)
    if not valid:
        if not any(v for row in matrix for v in row):
            return {"ok": True, "game_over": True, "best": None,
                    "message": "棋盘为空，请先输入数值（2、4、8…）"}
        return {"ok": True, "game_over": True, "best": None,
                "message": "当前局面已无合法走法（死局）"}
    scores, best, stats = ai2048.evaluate_directions(board, **opts)
    return {
        "ok": True,
        "game_over": False,
        "best": best,
        "best_name": ai2048.MOVE_NAMES[best],
        "arrow": ai2048.MOVE_ARROWS[best],
        "scores": scores,
        "valid_moves": valid,
        "board_after": board_after_move(matrix, best),
        "heur": round(ai2048.score_heur_board(board), 1),
        "actual_score": ai2048.board_score(board),
        "stats": stats,
    }


def api_auto(payload):
    matrix = validate_board(payload.get("board"))
    opts = parse_search_params(payload)
    max_steps = payload.get("max_steps", 200)
    try:
        max_steps = max(1, min(2000, int(max_steps)))
    except (TypeError, ValueError):
        max_steps = 200
    board = ai2048.matrix_to_board(matrix)
    if not ai2048.get_valid_moves(board):
        return {"ok": True, "game_over": True, "steps": [],
                "final_score": 0, "max_tile": ai2048.max_tile(board),
                "message": "当前局面已无合法走法（死局）"}
    result = ai2048.autoplay(board, max_steps=max_steps, **opts)
    result["ok"] = True
    return result


def api_simulate(payload):
    opts = parse_search_params(payload)
    games = payload.get("games", 5)
    try:
        games = max(1, min(50, int(games)))
    except (TypeError, ValueError):
        games = 5
    seed = payload.get("seed")
    if seed is not None:
        try:
            seed = int(seed)
        except (TypeError, ValueError):
            seed = None
    t0 = time.time()
    sim = ai2048.simulate(games=games, seed=seed, **opts)
    sim["ok"] = True
    sim["elapsed_ms"] = int((time.time() - t0) * 1000)
    # JSON 的 key 必须是字符串
    sim["tile_dist"] = {str(k): v for k, v in sim["tile_dist"].items()}
    return sim


# ---------------------------------------------------------------- 对局记录 API

def _int(payload, name, default=0, lo=None, hi=None):
    try:
        v = int(payload.get(name, default))
    except (TypeError, ValueError):
        v = default
    if lo is not None:
        v = max(lo, v)
    if hi is not None:
        v = min(hi, v)
    return v


def api_games_create(payload):
    """新建一局。前端每开一局调一次，之后用 upd 局部更新。"""
    gid = db.create_game(
        mode=payload.get("mode", "assistant"),
        board=payload.get("board") or [[0] * 4 for _ in range(4)],
        score=_int(payload, "score", 0, 0),
        moves=_int(payload, "moves", 0, 0),
        elapsed_ms=_int(payload, "elapsed_ms", 0, 0),
        note=payload.get("note", ""),
    )
    return {"ok": True, "id": gid, "game": db.get_game(gid)}


def api_games_update(payload):
    gid = _int(payload, "id", 0)
    if gid <= 0 or not db.get_game(gid):
        return {"ok": False, "error": f"对局 {gid} 不存在"}
    game = db.update_game(
        gid,
        board=payload.get("board"),
        score=payload.get("score"),
        moves=payload.get("moves"),
        elapsed_ms=payload.get("elapsed_ms"),
        is_over=payload.get("is_over"),
        note=payload.get("note"),
    )
    return {"ok": True, "game": game}


def api_games_move(payload):
    gid = _int(payload, "id", 0)
    if gid <= 0 or not db.get_game(gid):
        return {"ok": False, "error": f"对局 {gid} 不存在"}
    mid, step_no = db.add_move(
        gid,
        direction=_int(payload, "direction", 0),
        gain=_int(payload, "gain", 0, 0),
        score_after=_int(payload, "score_after", 0, 0),
        board_after=payload.get("board_after"),
        source=payload.get("source", "manual"),
    )
    # 着法流水记下了，顺手把主表的步数/分数/用时/盘面对齐，管理页不必二次计算
    game = db.update_game(
        gid,
        moves=step_no,
        score=_int(payload, "score_after", 0, 0),
        elapsed_ms=payload.get("elapsed_ms"),
        board=payload.get("board_after"),
    )
    return {"ok": True, "move_id": mid, "step_no": step_no, "game": game}


def api_games_delete(payload):
    gid = _int(payload, "id", 0)
    if gid <= 0:
        return {"ok": False, "error": "缺少 id"}
    return {"ok": True, "deleted": db.delete_game(gid)}


# ---------------------------------------------------------------- HTTP 服务

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "2048AI/1.0"
    protocol_version = "HTTP/1.1"

    # ---- 静态文件 + 对局记录查询
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        # /admin → 对局记录管理页
        if path in ("/admin", "/admin/"):
            return self._serve_static("/admin/index.html")

        if path == "/api/games/summary":
            return self._send_json(dict(db.summary(), ok=True))

        if path == "/api/games":
            q = parse_qs(parsed.query)
            mode = (q.get("mode") or [None])[0]
            is_over = (q.get("is_over") or [None])[0]
            order = (q.get("order") or ["updated"])[0]
            rows, total = db.list_games(
                mode=mode,
                is_over=None if is_over not in ("0", "1") else is_over == "1",
                order=order,
                limit=_int(q, "limit", 50, 1, 200),
                offset=_int(q, "offset", 0, 0),
            )
            return self._send_json({"ok": True, "games": rows, "total": total})

        if path.startswith("/api/games/"):
            tail = path[len("/api/games/"):]
            if tail.isdigit():
                gid = int(tail)
                game = db.get_game(gid)
                if not game:
                    return self._send_json({"ok": False, "error": f"对局 {gid} 不存在"}, 404)
                return self._send_json({"ok": True, "game": game,
                                        "moves": db.list_moves(gid)})
            return self._send_json({"ok": False, "error": f"未知接口 {path}"}, 404)

        # /site 与 /site/ → 官网 landing；/ → 应用本体
        if path in ("/site", "/site/"):
            path = "/site/index.html"
        elif path in ("/", "/index.html"):
            path = "/index.html"
        return self._serve_static(path)

    def _serve_static(self, path):
        # 防目录穿越
        safe = os.path.normpath(path).lstrip("/\\")
        full = os.path.join(STATIC_DIR, safe)
        if not os.path.abspath(full).startswith(os.path.abspath(STATIC_DIR)):
            self.send_error(403)
            return
        if not os.path.isfile(full):
            self.send_error(404)
            return
        ext = os.path.splitext(full)[1].lower()
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ---- API
    def do_POST(self):
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except (ValueError, UnicodeDecodeError):
            return self._send_json({"ok": False, "error": "请求体不是合法 JSON"}, 400)

        handlers = {
            "/api/best_move": api_best_move,
            "/api/auto": api_auto,
            "/api/simulate": api_simulate,
            "/api/games": api_games_create,
            "/api/games/upd": api_games_update,
            "/api/games/move": api_games_move,
            "/api/games/del": api_games_delete,
        }
        fn = handlers.get(path)
        if fn is None:
            return self._send_json({"ok": False, "error": f"未知接口 {path}"}, 404)
        try:
            result = fn(payload)
        except ValueError as e:
            return self._send_json({"ok": False, "error": str(e)}, 400)
        except Exception as e:  # 兜底，避免把堆栈暴露给前端
            return self._send_json({"ok": False, "error": f"服务器内部错误: {e}"}, 500)
        self._send_json(result, 200)

    def _send_json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))


def main():
    port = DEFAULT_PORT
    args = sys.argv[1:]
    if "--port" in args:
        i = args.index("--port")
        if i + 1 < len(args):
            port = int(args[i + 1])
    open_browser = "--no-browser" not in args

    ai2048.init_tables()
    db.init_db()
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = f"http://127.0.0.1:{port}/"
    print(f"2048 AI 服务已启动: {url}")
    print("API: POST /api/best_move  /api/auto  /api/simulate")
    print("记录: GET  /admin        /api/games  /api/games/<id>  /api/games/summary")
    print(f"数据库: {db.DB_PATH}")
    print("按 Ctrl+C 停止")
    if open_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
