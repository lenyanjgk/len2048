# -*- coding: utf-8 -*-
"""对局记录持久层自测：db.py 的建表、增删改查、级联删除、汇总。

作者：lenyanjgk（冷颜） · 2048 AI Web Assistant · MIT
用 LEN2048_DB 指向临时库，不碰正式的 games.db。
"""
import os
import shutil
import sys
import tempfile

TMP = tempfile.mkdtemp(prefix="len2048-db-")
os.environ["LEN2048_DB"] = os.path.join(TMP, "test.db")

import db  # noqa: E402  在设好环境后再导入

FAILED = []


def check(cond, msg):
    if cond:
        print("  [PASS]", msg)
    else:
        FAILED.append(msg)
        print("  [FAIL]", msg)


SAMPLE = [
    [1024, 512, 256, 0],
    [64, 32, 16, 8],
    [4, 8, 16, 0],
    [2, 4, 0, 0],
]


def main():
    db.init_db()
    print("== 建表与空库 ==")
    s = db.summary()
    check(s["games"] == 0 and s["logged_moves"] == 0, "空库汇总全为 0")
    check(db.DB_PATH.endswith("test.db"), "用的是临时库，不碰正式 games.db")

    print("== 建一局 ==")
    gid = db.create_game("assistant", SAMPLE, score=15688, moves=3, elapsed_ms=4200)
    check(gid > 0, f"create_game 返回 id={gid}")
    g = db.get_game(gid)
    check(g["mode"] == "assistant", "mode 正确")
    check(g["score"] == 15688, "score 正确")
    check(g["max_tile"] == 1024, "max_tile 由盘面自动算出（1024）")
    check(g["is_over"] == 0, "新局默认未结束")
    check(g["created_at"] and g["updated_at"], "时间戳已填")

    print("== 局部更新 ==")
    g2 = db.update_game(gid, score=20000, moves=5, elapsed_ms=9000)
    check(g2["score"] == 20000 and g2["moves"] == 5, "更新生效")
    check(g2["board"] == g["board"], "没传 board 时盘面不被清掉")
    check(g2["updated_at"] >= g["updated_at"], "updated_at 往前走")

    print("== 着法流水 ==")
    for i, (d, gain, sc) in enumerate([(2, 0, 15688), (0, 256, 15944), (3, 8, 15952)]):
        mid, step = db.add_move(gid, direction=d, gain=gain, score_after=sc,
                                board_after=SAMPLE, source="manual")
        check(step == i + 1, f"第 {i + 1} 步 step_no={step}")
    mv = db.list_moves(gid)
    check(len(mv) == 3, "共 3 步")
    check(mv[0]["direction_name"] == "左" and mv[1]["direction_name"] == "上"
          and mv[2]["direction_name"] == "右", "方向名按 0上1下2左3右 映射")
    check([m["source"] for m in mv] == ["manual"] * 3, "source 记录为 manual")

    print("== 死局 ==")
    dead = [[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]]
    gid2 = db.create_game("free", dead, score=999)
    db.update_game(gid2, is_over=True)
    g2 = db.get_game(gid2)
    check(g2["is_over"] == 1, "is_over 置 1")
    check(g2["ended_at"] is not None, "ended_at 已填")

    print("== 查询与筛选 ==")
    db.create_game("free", SAMPLE, score=50000)
    rows, total = db.list_games()
    check(total == 3, f"list_games 总数为 3（实际 {total}）")
    rows, total = db.list_games(mode="free")
    check(total == 2 and all(r["mode"] == "free" for r in rows), "按 mode 筛选")
    rows, total = db.list_games(is_over=True)
    check(total == 1 and rows[0]["id"] == gid2, "按死局筛选")
    rows, _ = db.list_games(order="score")
    check(rows[0]["score"] == 50000, "按分数排序，最高在前")
    rows, _ = db.list_games(limit=2, offset=0)
    check(len(rows) == 2, "limit 生效")
    rows, _ = db.list_games(limit=2, offset=2)
    check(len(rows) == 1, "offset 生效")

    print("== 汇总 ==")
    s = db.summary()
    check(s["games"] == 3, "汇总局数 3")
    check(s["over_games"] == 1, "死局 1")
    check(s["live_games"] == 2, "进行中 2")
    check(s["best_score"] == 50000, "最高分 50000")
    check(s["best_tile"] == 1024, "最大块记录 1024")
    check(s["total_moves"] == 5, "记分板步数之和 = 5（第一局 5 + 另两局 0）")
    check(s["logged_moves"] == 3, "着法流水行数 = 3")
    check(s["by_mode"] == {"assistant": 1, "free": 2}, "按模式分布")

    print("== 校验 ==")
    for bad, why in [
        ([[1, 0, 0, 0], [0] * 4, [0] * 4, [0] * 4], "非 2 的幂"),
        ([[65536, 0, 0, 0], [0] * 4, [0] * 4, [0] * 4], "超过 32768"),
        ([[0, 0, 0], [0] * 4, [0] * 4, [0] * 4], "不是 4x4"),
        ("nope", "根本不是矩阵"),
    ]:
        try:
            db.validate_board(bad)
            check(False, f"应拒绝：{why}")
        except ValueError:
            check(True, f"拒绝非法盘面：{why}")
    try:
        db.add_move(gid, direction=9)
        check(False, "应拒绝非法 direction")
    except ValueError:
        check(True, "拒绝非法 direction")
    try:
        db.add_move(gid, direction=0, source="bogus")
        check(False, "应拒绝非法 source")
    except ValueError:
        check(True, "拒绝非法 source")

    print("== 级联删除 ==")
    check(db.delete_game(gid) is True, "删除存在的一局")
    check(db.get_game(gid) is None, "局已没了")
    check(db.list_moves(gid) == [], "它的着法流水被级联删掉")
    check(db.delete_game(99999) is False, "删除不存在的一局返回 False")
    s = db.summary()
    check(s["games"] == 2 and s["logged_moves"] == 0, "删完汇总跟着变")

    print("== 更新不存在的局 ==")
    r = db.update_game(99999, score=1)
    check(r is None, "更新不存在的一局返回 None")

    db.close_db()
    shutil.rmtree(TMP, ignore_errors=True)
    print()
    if FAILED:
        print(f"{len(FAILED)} 处失败")
        sys.exit(1)
    print("ALL DB TESTS PASSED")


if __name__ == "__main__":
    main()
