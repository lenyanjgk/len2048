# -*- coding: utf-8 -*-
"""生成随机棋盘 + Python 引擎的移动结果，供 test_logic.js 与前端对拍

作者：lenyanjgk（冷颜） · 2048 AI Web Assistant · MIT
"""
import json
import random

import ai2048


def main():
    ai2048.init_tables()
    rng = random.Random(2024)
    cases = []
    for _ in range(400):
        m = [[0] * 4 for _ in range(4)]
        cells = [(r, c) for r in range(4) for c in range(4)]
        rng.shuffle(cells)
        for r, c in cells[:rng.randint(2, 15)]:
            m[r][c] = 1 << rng.randint(1, 10)
        b = ai2048.matrix_to_board(m)
        expected = [ai2048.board_to_matrix(ai2048.execute_move(d, b)) for d in range(4)]
        cases.append({
            "board": m,
            "expected": expected,
            "has_move": bool(ai2048.get_valid_moves(b)),
        })
    with open("cases.json", "w", encoding="utf-8") as f:
        json.dump(cases, f)
    print(f"generated {len(cases)} cases")


if __name__ == "__main__":
    main()
