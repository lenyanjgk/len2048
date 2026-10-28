# -*- coding: utf-8 -*-
"""
2048 Expectimax AI —— 自研算法核心（纯 Python，零第三方依赖）

作者：lenyanjgk（冷颜） · 2048 AI Web Assistant · MIT

核心思路：
  1. 64 位 bitboard 棋盘：每格 4 bit 存 rank（rank = log2(数值)，0=空，1=2，2=4 ... 15=32768）
  2. 4 张 65536 移动查找表（row_left / row_right / col_up / col_down）
  3. 2 张 65536 评分查找表（score_table 真实分 / heur_score_table 启发分）
  4. Expectimax 双递归：
       - move_node      MAX 节点（玩家 4 个方向取最大）
       - tilechoose     CHANCE 节点（每个空格按 2:90% / 4:10% 加权求期望）
  5. 概率截断：累计概率低于阈值的分支不再展开
  6. 递进搜索深度：depth_limit = max(3, 盘面不同数字种数 - 2)
  7. 置换表：缓存 (depth, heuristic)，仅当记录深度 <= 当前深度时才命中

纯 Python 落地的关键工程处理：
  - 有界循环：编译型语言可依赖定宽整数溢出归零来结束位移循环，
    Python 大整数无上限，必须显式限制次数，否则空格枚举永不结束
  - 迭代加深 + 死线检查：从深度 1 逐层加深，超时抛异常回退到
    最近完成的深度，保证任何机器都在预算时间内返回推荐

Python 3.8+ 直接运行。方向编号：0=上 1=下 2=左 3=右
"""

import random
import time

# ---------------------------------------------------------------- 常量

ROW_MASK = 0xFFFF
COL_MASK = 0x000F000F000F000F

# 启发式权重
SCORE_LOST_PENALTY = 200000.0
SCORE_MONOTONICITY_POWER = 4.0
SCORE_MONOTONICITY_WEIGHT = 47.0
SCORE_SUM_POWER = 3.5
SCORE_SUM_WEIGHT = 11.0
SCORE_MERGES_WEIGHT = 700.0
SCORE_EMPTY_WEIGHT = 270.0

CPROB_THRESH_BASE = 0.0001   # probcut 阈值
CACHE_DEPTH_LIMIT = 15       # 置换表启用深度

MOVE_NAMES = ("up", "down", "left", "right")
MOVE_ARROWS = ("↑", "↓", "←", "→")

MAX_RANK = 15                # 支持的最大 rank（32768）

# ---------------------------------------------------------------- 查找表

_tables_ready = False
row_left_table = []
row_right_table = []
col_up_table = []
col_down_table = []
heur_score_table = []
score_table = []


def reverse_row(row):
    """反转一行的 4 个 nibble（C++ reverse_row）"""
    return ((row >> 12) | ((row >> 4) & 0x00F0) | ((row << 4) & 0x0F00)
            | ((row << 12) & 0xF000)) & 0xFFFF


def unpack_col(row):
    """把一行的 4 个 nibble 铺开成一列的 4 个 nibble（C++ unpack_col）"""
    tmp = row
    return (tmp | (tmp << 12) | (tmp << 24) | (tmp << 36)) & COL_MASK


def transpose(x):
    """行列互换（C++ transpose）"""
    a1 = x & 0xF0F00F0FF0F00F0F
    a2 = x & 0x0000F0F00000F0F0
    a3 = x & 0x0F0F00000F0F0000
    a = a1 | (a2 << 12) | (a3 >> 12)
    b1 = a & 0xFF00FF0000FF00FF
    b2 = a & 0x00FF00FF00000000
    b3 = a & 0x00000000FF00FF00
    return b1 | (b2 >> 24) | (b3 << 24)


def count_empty(x):
    """数空格数（C++ count_empty，位运算）。全空盘返回 0（与 C++ 相同的 16 取模行为）"""
    x |= (x >> 2) & 0x3333333333333333
    x |= (x >> 1)
    x = ~x & 0x1111111111111111
    x += x >> 32
    x += x >> 16
    x += x >> 8
    x += x >> 4
    return x & 0xF


def count_distinct_tiles(board):
    """数盘面上有多少种不同的数值（C++ count_distinct_tiles）"""
    bitset = 0
    while board:
        bitset |= 1 << (board & 0xF)
        board >>= 4
    bitset >>= 1  # 不计空格
    count = 0
    while bitset:
        bitset &= bitset - 1
        count += 1
    return count


def init_tables():
    """预生成全部查找表（对应 C++ init_tables）"""
    global _tables_ready, row_left_table, row_right_table
    global col_up_table, col_down_table, heur_score_table, score_table
    if _tables_ready:
        return

    row_left_table = [0] * 65536
    row_right_table = [0] * 65536
    col_up_table = [0] * 65536
    col_down_table = [0] * 65536
    heur_score_table = [0.0] * 65536
    score_table = [0.0] * 65536

    for row in range(65536):
        line = [(row >> 0) & 0xF, (row >> 4) & 0xF,
                (row >> 8) & 0xF, (row >> 12) & 0xF]

        # ---- 真实分：每个方块贡献 (rank-1) * 2^rank（含中间合并过程）
        sc = 0.0
        for rank in line:
            if rank >= 2:
                sc += (rank - 1) * (1 << rank)
        score_table[row] = sc

        # ---- 启发分：空格奖励 + 可合并奖励 - 单调性惩罚 - 分布惩罚
        s = 0.0
        empty = 0
        merges = 0
        prev = 0
        counter = 0
        for rank in line:
            s += rank ** SCORE_SUM_POWER
            if rank == 0:
                empty += 1
            else:
                if prev == rank:
                    counter += 1
                elif counter > 0:
                    merges += 1 + counter
                    counter = 0
                prev = rank
        if counter > 0:
            merges += 1 + counter

        mono_left = 0.0
        mono_right = 0.0
        for i in range(1, 4):
            if line[i - 1] > line[i]:
                mono_left += (line[i - 1] ** SCORE_MONOTONICITY_POWER
                              - line[i] ** SCORE_MONOTONICITY_POWER)
            else:
                mono_right += (line[i] ** SCORE_MONOTONICITY_POWER
                               - line[i - 1] ** SCORE_MONOTONICITY_POWER)

        heur_score_table[row] = (SCORE_LOST_PENALTY
                                 + SCORE_EMPTY_WEIGHT * empty
                                 + SCORE_MERGES_WEIGHT * merges
                                 - SCORE_MONOTONICITY_WEIGHT * min(mono_left, mono_right)
                                 - SCORE_SUM_WEIGHT * s)

        # ---- 预计算"向左滑动"的结果行（滑动会就地修改 line）
        i = 0
        while i < 3:
            j = i + 1
            while j < 4 and line[j] == 0:
                j += 1
            if j == 4:
                break
            if line[i] == 0:
                line[i] = line[j]
                line[j] = 0
                # i 不变，重试同一格
            elif line[i] == line[j]:
                if line[i] != 0xF:
                    line[i] += 1
                line[j] = 0
                i += 1
            else:
                i += 1

        result = line[0] | (line[1] << 4) | (line[2] << 8) | (line[3] << 12)
        rev_result = reverse_row(result)
        rev_row = reverse_row(row)

        row_left_table[row] = row ^ result
        row_right_table[rev_row] = rev_row ^ rev_result
        col_up_table[row] = unpack_col(row) ^ unpack_col(result)
        col_down_table[rev_row] = unpack_col(rev_row) ^ unpack_col(rev_result)

    _tables_ready = True


# ---------------------------------------------------------------- 棋盘 <-> 矩阵

def matrix_to_board(matrix):
    """4x4 矩阵（元素为实际数值，0 表示空）转 bitboard"""
    board = 0
    i = 0
    for row in matrix:
        for c in row:
            c = int(c)
            rank = 0 if c == 0 else c.bit_length() - 1
            board |= rank << (4 * i)
            i += 1
    return board


def board_to_matrix(board):
    """bitboard 转 4x4 矩阵（实际数值）"""
    m = []
    i = 0
    for _ in range(4):
        row = []
        for _ in range(4):
            rank = (board >> (4 * i)) & 0xF
            row.append(0 if rank == 0 else 1 << rank)
            i += 1
        m.append(row)
    return m


def max_tile(board):
    """盘面最大数值"""
    rank = 0
    while board:
        r = board & 0xF
        if r > rank:
            rank = r
        board >>= 4
    return 1 << rank


def board_score(board):
    """按标准 2048 规则计算的真实分（= 各次合并增益之和）"""
    return int(score_board(board))


# ---------------------------------------------------------------- 移动

def execute_move(move, board):
    """执行移动，返回新 board（C++ execute_move）。move: 0上 1下 2左 3右"""
    if move == 0:      # up
        t = transpose(board)
        return (board
                ^ (col_up_table[t & ROW_MASK])
                ^ (col_up_table[(t >> 16) & ROW_MASK] << 4)
                ^ (col_up_table[(t >> 32) & ROW_MASK] << 8)
                ^ (col_up_table[(t >> 48) & ROW_MASK] << 12))
    if move == 1:      # down
        t = transpose(board)
        return (board
                ^ (col_down_table[t & ROW_MASK])
                ^ (col_down_table[(t >> 16) & ROW_MASK] << 4)
                ^ (col_down_table[(t >> 32) & ROW_MASK] << 8)
                ^ (col_down_table[(t >> 48) & ROW_MASK] << 12))
    if move == 2:      # left
        return (board
                ^ (row_left_table[board & ROW_MASK])
                ^ (row_left_table[(board >> 16) & ROW_MASK] << 16)
                ^ (row_left_table[(board >> 32) & ROW_MASK] << 32)
                ^ (row_left_table[(board >> 48) & ROW_MASK] << 48))
    # right
    return (board
            ^ (row_right_table[board & ROW_MASK])
            ^ (row_right_table[(board >> 16) & ROW_MASK] << 16)
            ^ (row_right_table[(board >> 32) & ROW_MASK] << 32)
            ^ (row_right_table[(board >> 48) & ROW_MASK] << 48))


def get_valid_moves(board):
    """合法方向列表"""
    return [m for m in range(4) if execute_move(m, board) != board]


# ---------------------------------------------------------------- 评分

def _score_helper(board, table):
    return (table[board & ROW_MASK]
            + table[(board >> 16) & ROW_MASK]
            + table[(board >> 32) & ROW_MASK]
            + table[(board >> 48) & ROW_MASK])


def score_heur_board(board):
    """启发分（行列各算一次）"""
    return (_score_helper(board, heur_score_table)
            + _score_helper(transpose(board), heur_score_table))


def score_board(board):
    """真实分"""
    return _score_helper(board, score_table)


# ---------------------------------------------------------------- Expectimax 搜索

class _SearchTimeout(Exception):
    """搜索超过时间盒时抛出，用于回退到最近完成的深度"""


def _search(board0, depth_limit, prob_thresh, trans_table, counters, deadline=None):
    """
    对单个方向的顶层评估（对应 C++ _score_toplevel_move 内部的递归）。
    board0: 已执行玩家移动后的棋盘；递归从 depth=0 的 CHANCE 节点开始。
    热路径全部内联，闭包局部变量加速。
    deadline: 时间死线（time.time() 值），超时抛 _SearchTimeout。
    """
    heur = heur_score_table
    cache_limit = CACHE_DEPTH_LIMIT
    nodes = 0
    hits = 0
    maxd = 0

    def heur_board(b):
        return (_score_helper(b, heur) + _score_helper(transpose(b), heur))

    def tilechoose(b, cprob, d):
        # CHANCE 节点：枚举每个空格放 2(90%) / 4(10%)
        nonlocal nodes, hits, maxd
        if (nodes & 2047) == 0 and deadline is not None and time.time() > deadline:
            raise _SearchTimeout()
        if cprob < prob_thresh or d >= depth_limit:
            if d > maxd:
                maxd = d
            return heur_board(b)
        if d < cache_limit:
            e = trans_table.get(b)
            if e is not None and e[0] <= d:
                hits += 1
                return e[1]
        num_open = count_empty(b)
        if num_open == 0:
            # 满盘（极少见）：C++ 这里会算出 NaN，Python 直接按启发分截止
            return heur_board(b)
        cp = cprob / num_open
        res = 0.0
        tmp = b
        tile_2 = 1
        for _ in range(16):   # 注意：必须用有界循环，Python 大整数不会溢出归零
            if (tmp & 0xF) == 0:
                res += move_node(b | tile_2, cp * 0.9, d + 1) * 0.9
                res += move_node(b | (tile_2 << 1), cp * 0.1, d + 1) * 0.1
            tmp >>= 4
            tile_2 <<= 4
        res /= num_open
        if d < cache_limit:
            trans_table[b] = (d, res)
        return res

    def move_node(b, cprob, d):
        # MAX 节点：4 个方向取最大（内联 execute_move 提速）
        nonlocal nodes
        best = 0.0
        t = transpose(b)
        nb = (b
              ^ (col_up_table[t & ROW_MASK])
              ^ (col_up_table[(t >> 16) & ROW_MASK] << 4)
              ^ (col_up_table[(t >> 32) & ROW_MASK] << 8)
              ^ (col_up_table[(t >> 48) & ROW_MASK] << 12))
        if nb != b:
            nodes += 1
            v = tilechoose(nb, cprob, d)
            if v > best:
                best = v
        nb = (b
              ^ (col_down_table[t & ROW_MASK])
              ^ (col_down_table[(t >> 16) & ROW_MASK] << 4)
              ^ (col_down_table[(t >> 32) & ROW_MASK] << 8)
              ^ (col_down_table[(t >> 48) & ROW_MASK] << 12))
        if nb != b:
            nodes += 1
            v = tilechoose(nb, cprob, d)
            if v > best:
                best = v
        nb = (b
              ^ (row_left_table[b & ROW_MASK])
              ^ (row_left_table[(b >> 16) & ROW_MASK] << 16)
              ^ (row_left_table[(b >> 32) & ROW_MASK] << 32)
              ^ (row_left_table[(b >> 48) & ROW_MASK] << 48))
        if nb != b:
            nodes += 1
            v = tilechoose(nb, cprob, d)
            if v > best:
                best = v
        nb = (b
              ^ (row_right_table[b & ROW_MASK])
              ^ (row_right_table[(b >> 16) & ROW_MASK] << 16)
              ^ (row_right_table[(b >> 32) & ROW_MASK] << 32)
              ^ (row_right_table[(b >> 48) & ROW_MASK] << 48))
        if nb != b:
            nodes += 1
            v = tilechoose(nb, cprob, d)
            if v > best:
                best = v
        return best

    # 死线检查内联在 tilechoose 入口（每 2048 个节点查一次时间），
    # 超时抛 _SearchTimeout 向上 unwind，由 evaluate_directions 回退到上层深度
    result = tilechoose(board0, 1.0, 0)

    counters["nodes"] = nodes
    counters["hits"] = hits
    counters["maxd"] = maxd
    return result


def _evaluate_at_depth(board, depth_limit, prob_thresh, deadline=None):
    """
    固定深度下对 4 个方向打分（C++ score_toplevel_move x4）。
    每个深度层使用全新置换表（与 C++ 每次搜索新建 trans_table 一致）；
    层内 4 个方向共享一张表（命中规则与 C++ 相同：记录深度 <= 当前深度）。
    注意：表绝不能跨深度层共享——否则浅层缓存会让深层搜索直接返回浅层值，
    迭代加深会被彻底废掉。
    """
    scores = [0.0, 0.0, 0.0, 0.0]
    trans_table = {}
    nodes = hits = maxd = 0
    for move in range(4):
        nb = execute_move(move, board)
        if nb == board:
            continue
        counters = {}
        val = _search(nb, depth_limit, prob_thresh, trans_table, counters, deadline)
        scores[move] = val + 1e-6   # 与 C++ 一致，避免平级时抖动
        nodes += counters["nodes"]
        hits += counters["hits"]
        maxd = max(maxd, counters["maxd"])
    best = max(range(4), key=lambda m: scores[m])
    stats = {"depth": depth_limit, "nodes": nodes, "cache_hits": hits,
             "max_depth_reached": maxd}
    return scores, best, stats


def evaluate_directions(board, depth_mode="adaptive", fixed_depth=4,
                        max_depth=8, prob_thresh=CPROB_THRESH_BASE,
                        time_budget_ms=3000):
    """
    对 4 个方向打分，返回 (scores, best_move, stats)。非法方向分数为 0。

    depth_mode:
      "adaptive" 递进深度 max(3, distinct-2)
      "fixed"    固定深度
    两种模式都走迭代加深（1, 2, 3 ... target），并用时间盒截断：
    超时抛 _SearchTimeout 回退到最近完成的深度，保证必有返回。
    每个深度层使用独立置换表（见 _evaluate_at_depth 注释）。
    max_depth: 深度上限。time_budget_ms: 时间盒（毫秒）。
    """
    init_tables()
    start = time.time()
    deadline = start + time_budget_ms / 1000.0 if time_budget_ms else None

    if depth_mode == "fixed":
        target = max(1, int(fixed_depth))
    else:
        base = max(3, count_distinct_tiles(board) - 2)
        target = min(base, int(max_depth)) if max_depth else base
        target = max(target, 1)

    result = None
    timed_out = False
    for dl in range(1, target + 1):
        try:
            scores, best, stats = _evaluate_at_depth(
                board, dl, prob_thresh, deadline)
        except _SearchTimeout:
            timed_out = True
            break
        result = (scores, best, stats)
        if deadline is not None and time.time() >= deadline:
            timed_out = dl < target
            break

    if result is None:
        # 理论兜底：深度 1 都不可能超时；真出现就无死线重搜一次
        result = _evaluate_at_depth(board, 1, prob_thresh, None)

    scores, best, stats = result
    stats = dict(stats)
    stats["elapsed_ms"] = int((time.time() - start) * 1000)
    stats["timed_out"] = timed_out
    stats["target_depth"] = target
    return scores, best, stats


# ---------------------------------------------------------------- 对局模拟

def insert_random_tile(board, rng=random):
    """随机出块：90% 出 2，10% 出 4"""
    empty_cells = [i for i in range(16) if ((board >> (4 * i)) & 0xF) == 0]
    if not empty_cells:
        return board
    i = rng.choice(empty_cells)
    rank = 1 if rng.random() < 0.9 else 2
    return board | (rank << (4 * i))


def initial_board(rng=random):
    """新开局：2 个随机块"""
    return insert_random_tile(insert_random_tile(0, rng), rng)


def _search_opts(kwargs):
    return (kwargs.get("depth_mode", "adaptive"),
            kwargs.get("fixed_depth", 4),
            kwargs.get("max_depth", 8),
            kwargs.get("prob_thresh", CPROB_THRESH_BASE),
            kwargs.get("time_budget_ms", 3000))


def autoplay(board, max_steps=2000, rng=random, **kwargs):
    """从给定局面让 AI 自动下完，返回逐步记录（供网页演示）"""
    init_tables()
    depth_mode, fixed_depth, max_depth, prob_thresh, budget_ms = _search_opts(kwargs)
    steps = []
    score = 0
    total_nodes = 0
    for _ in range(max_steps):
        if not get_valid_moves(board):
            break
        _, best, stats = evaluate_directions(
            board, depth_mode, fixed_depth, max_depth, prob_thresh,
            time_budget_ms=budget_ms)
        total_nodes += stats["nodes"]
        nb = execute_move(best, board)
        gain = score_board(nb) - score_board(board)
        score += gain
        board = insert_random_tile(nb, rng)
        steps.append({
            "move": best,
            "move_name": MOVE_NAMES[best],
            "arrow": MOVE_ARROWS[best],
            "gain": int(gain),
            "score": int(score),
            "board": board_to_matrix(board),
            "max_tile": max_tile(board),
        })
    return {
        "steps": steps,
        "final_score": int(score),
        "max_tile": max_tile(board),
        "game_over": not get_valid_moves(board),
        "total_nodes": total_nodes,
    }


def simulate(games=10, seed=None, **kwargs):
    """从零跑 N 局，返回每局 (score, max_tile) 与汇总统计"""
    init_tables()
    rng = random.Random(seed)
    depth_mode, fixed_depth, max_depth, prob_thresh, budget_ms = _search_opts(kwargs)
    results = []
    for _ in range(games):
        board = initial_board(rng)
        score = 0
        while get_valid_moves(board):
            _, best, _ = evaluate_directions(
                board, depth_mode, fixed_depth, max_depth, prob_thresh,
                time_budget_ms=budget_ms)
            nb = execute_move(best, board)
            score += score_board(nb) - score_board(board)
            board = insert_random_tile(nb, rng)
        results.append((int(score), max_tile(board)))
    scores = [r[0] for r in results]
    tile_dist = {}
    for _, t in results:
        tile_dist[t] = tile_dist.get(t, 0) + 1
    return {
        "games": games,
        "results": results,
        "mean_score": sum(scores) / len(scores) if scores else 0,
        "max_score": max(scores) if scores else 0,
        "min_score": min(scores) if scores else 0,
        "tile_dist": tile_dist,
    }
