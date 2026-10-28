# -*- coding: utf-8 -*-
"""ai2048 自测套件（作者：lenyanjgk / 冷颜，MIT）：
1. execute_move vs 朴素实现随机对拍
2. count_empty / score_board / 移动增益 不变式
3. autoplay 状态转移不变式（新块必须生成到移动后的棋盘上）
4. 强度 sanity（300 步后最大块 >= 64）
"""
import random
import time

import ai2048
from ai2048 import (matrix_to_board, board_to_matrix, execute_move,
                    count_empty, count_distinct_tiles, evaluate_directions,
                    autoplay, initial_board, insert_random_tile,
                    get_valid_moves, score_board, max_tile, MOVE_NAMES)


def naive_move(m, d):
    """朴素参照实现：返回 (新矩阵, 合并增益)"""
    def merge_line(line):
        tiles = [v for v in line if v]
        out, gain, i = [], 0, 0
        while i < len(tiles):
            if i + 1 < len(tiles) and tiles[i] == tiles[i + 1]:
                v = tiles[i] * 2
                gain += v
                out.append(v)
                i += 2
            else:
                out.append(tiles[i])
                i += 1
        while len(out) < 4:
            out.append(0)
        return out, gain

    out = [[0] * 4 for _ in range(4)]
    gain = 0
    for k in range(4):
        if d == 0:
            res, g = merge_line([m[0][k], m[1][k], m[2][k], m[3][k]])
            for x in range(4):
                out[x][k] = res[x]
        elif d == 1:
            res, g = merge_line([m[3][k], m[2][k], m[1][k], m[0][k]])
            for x in range(4):
                out[3 - x][k] = res[x]
        elif d == 2:
            res, g = merge_line([m[k][0], m[k][1], m[k][2], m[k][3]])
            for c in range(4):
                out[k][c] = res[c]
        else:
            res, g = merge_line([m[k][3], m[k][2], m[k][1], m[k][0]])
            for c in range(4):
                out[k][3 - c] = res[c]
        gain += g
    return out, gain


def random_matrix(rng, lo=2, hi=15):
    m = [[0] * 4 for _ in range(4)]
    cells = [(r, c) for r in range(4) for c in range(4)]
    rng.shuffle(cells)
    for r, c in cells[:rng.randint(lo, hi)]:
        m[r][c] = 1 << rng.randint(1, 10)
    return m


def total_value(board):
    return sum(1 << ((board >> (4 * i)) & 0xF)
               for i in range(16) if ((board >> (4 * i)) & 0xF))


def test_move_tables():
    rng = random.Random(42)
    mismatch = cbad = 0
    for _ in range(300):
        m = random_matrix(rng)
        b = matrix_to_board(m)
        expect_empty = sum(1 for r in m for v in r if v == 0)
        if expect_empty != 16 and count_empty(b) != expect_empty:
            cbad += 1
        for d in range(4):
            ref, _ = naive_move(m, d)
            if board_to_matrix(execute_move(d, b)) != ref:
                mismatch += 1
    assert mismatch == 0, f"execute_move 对拍失败 {mismatch} 处"
    assert cbad == 0, f"count_empty 失败 {cbad} 处"
    print("[PASS] execute_move 对拍 300 局 x 4 方向 + count_empty")


def test_score_invariants():
    rng = random.Random(7)

    def naive_score(m):
        s = 0
        for row in m:
            for v in row:
                if v >= 4:
                    s += (v.bit_length() - 2) * v
        return s

    bad1 = bad2 = 0
    for _ in range(1000):
        m = random_matrix(rng, 2, 16)
        b = matrix_to_board(m)
        if abs(score_board(b) - naive_score(m)) > 1e-9:
            bad1 += 1
        for d in range(4):
            nb = execute_move(d, b)
            _, expect = naive_move(m, d)
            if abs((score_board(nb) - score_board(b)) - expect) > 1e-9:
                bad2 += 1
    assert bad1 == 0 and bad2 == 0
    print("[PASS] score_board 与移动增益不变式 1000 局")


def test_autoplay_invariants():
    """核心回归：新块必须生成到移动后的棋盘；
    用 面值守恒 + 分数守恒 两个方程反推生成块数并校验。"""
    rng = random.Random(7)
    board = initial_board(rng)
    steps = 300
    res = autoplay(board, max_steps=steps, rng=rng,
                   depth_mode="adaptive", max_depth=10, time_budget_ms=150)
    n = len(res["steps"])
    assert n >= 100, f"autoplay 步数异常: {n}"
    last = matrix_to_board(res["steps"][-1]["board"])
    init_tv = total_value(board)
    last_tv = total_value(last)
    init_sb = score_board(board)
    last_sb = score_board(last)
    # 方程1: last_tv - init_tv = 2*n2 + 4*n4
    # 方程2: last_sb - init_sb = score + 4*n4
    n4 = (last_sb - init_sb - res["final_score"]) / 4
    n2 = (last_tv - init_tv - 4 * n4) / 2
    assert abs(n4 - round(n4)) < 1e-6 and abs(n2 - round(n2)) < 1e-6, \
        f"生成块数非整数: n4={n4} n2={n2}"
    n4, n2 = round(n4), round(n2)
    assert n4 >= 0 and n2 >= 0, f"生成块数为负: n4={n4} n2={n2}"
    assert n2 + n4 == n, f"每步应生成一块: n2+n4={n2 + n4} != steps={n}"
    assert res["max_tile"] >= 64, f"300 步后最大块应 >= 64, 实际 {res['max_tile']}"
    assert res["final_score"] >= 1000, f"300 步后分数应 >= 1000, 实际 {res['final_score']}"
    print(f"[PASS] autoplay 不变式: {n} 步, 生成 2x{n2} + 4x{n4}, "
          f"得分 {res['final_score']}, 最大块 {res['max_tile']}")


def test_hint_sanity():
    """角部集中盘 vs 散乱盘：启发分与推荐合理性"""
    good = [[64, 32, 16, 8], [8, 4, 2, 0], [0, 0, 0, 0], [0, 0, 0, 0]]
    bad = [[8, 0, 8, 0], [16, 0, 16, 0], [32, 0, 32, 0], [64, 0, 0, 0]]
    hg = ai2048.score_heur_board(matrix_to_board(good))
    hb = ai2048.score_heur_board(matrix_to_board(bad))
    assert hg > hb, f"启发分排序错误: good={hg} bad={hb}"
    scores, best, stats = evaluate_directions(
        matrix_to_board(good), depth_mode="fixed", fixed_depth=3,
        time_budget_ms=10000)
    assert best in get_valid_moves(matrix_to_board(good))
    assert stats["nodes"] > 0 and stats["cache_hits"] > 0
    print(f"[PASS] 启发分排序 + 推荐合法 (best={MOVE_NAMES[best]}, "
          f"{stats['nodes']} 节点, {stats['cache_hits']} 命中)")


if __name__ == "__main__":
    t0 = time.time()
    ai2048.init_tables()
    test_move_tables()
    test_score_invariants()
    test_hint_sanity()
    test_autoplay_invariants()
    print(f"\nALL TESTS PASSED ({time.time() - t0:.1f}s)")
