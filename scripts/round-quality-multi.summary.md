# D19 ③ — multi-model round-quality on 54 rounds (D131 retest with public endpoints)

Models: Jev (noul) + 5 OpenAI-compatible: yty-gpt-5.6, yty-gpt-5.6-sol, yty-gpt-5.5, yty-gpt-6, lbl-gemini-3.7-flash

## Confusion matrix (truth = Jev baseline `jevBaseline >= 0.5`)

| predictor | acc | tp | fp | tn | fn |
|---|---|---|---|---|---|
| D19 mechanical | 75.9% | 24 | 13 | 17 | 0 |
| Jev baseline (the truth) | 100.0% | 24 | 0 | 30 | 0 |
| yty-gpt-5.6 complete | 90.7% | 20 | 1 | 29 | 4 |
| yty-gpt-5.6-sol complete | 92.6% | 21 | 1 | 29 | 3 |
| yty-gpt-5.5 complete | 94.4% | 21 | 0 | 30 | 3 |
| yty-gpt-6 complete | 92.6% | 21 | 1 | 29 | 3 |
| lbl-gemini-3.7-flash complete | 92.6% | 22 | 2 | 28 | 2 |
| Jev complete (noul re-ask) | 96.3% | 23 | 1 | 29 | 1 |
| multi-consensus (mean complete) | 96.3% | 23 | 1 | 29 | 1 |
| D19 AND consensus | 96.3% | 23 | 1 | 29 | 1 |
| D19 OR consensus | 75.9% | 24 | 13 | 17 | 0 |

## Per-model response rate

| model | responded | rate |
|---|---|---|
| jev | 54/54 | 100.0% |
| yty-gpt-5.6 | 54/54 | 100.0% |
| yty-gpt-5.6-sol | 54/54 | 100.0% |
| yty-gpt-5.5 | 54/54 | 100.0% |
| yty-gpt-6 | 54/54 | 100.0% |
| lbl-gemini-3.7-flash | 54/54 | 100.0% |

## D19 says success but Jev baseline < 0.5 (13 cases)

- "hi" jev=0.05 jev=0.09 yty-gpt-5.6=0.10 yty-gpt-5.6-sol=0.00 yty-gpt-5.5=0.20 yty-gpt-6=0.00 lbl-gemini-3.7-flash=0.00 mean=0.07 ✗ multi-consensus misses
- "OK" jev=0.05 jev=0.05 yty-gpt-5.6=0.00 yty-gpt-5.6-sol=0.00 yty-gpt-5.5=0.00 yty-gpt-6=0.00 lbl-gemini-3.7-flash=0.00 mean=0.01 ✗ multi-consensus misses
- "bug" jev=0.03 jev=0.04 yty-gpt-5.6=0.00 yty-gpt-5.6-sol=0.00 yty-gpt-5.5=0.10 yty-gpt-6=0.00 lbl-gemini-3.7-flash=0.00 mean=0.02 ✗ multi-consensus misses
- "你不是应该给我结果吗" jev=0.14 jev=0.19 yty-gpt-5.6=0.20 yty-gpt-5.6-sol=0.20 yty-gpt-5.5=0.00 yty-gpt-6=0.00 lbl-gemini-3.7-flash=0.00 mean=0.10 ✗ multi-consensus misses
- "继续" jev=0.41 jev=0.72 yty-gpt-5.6=0.15 yty-gpt-5.6-sol=0.15 yty-gpt-5.5=0.20 yty-gpt-6=0.40 lbl-gemini-3.7-flash=0.00 mean=0.27 ✗ multi-consensus misses
- "创建一个HTML，内容是SVG绘制一个北极熊骑自行车的2D动画，
你不需要任何测试。" jev=0.06 jev=0.09 yty-gpt-5.6=0.05 yty-gpt-5.6-sol=0.05 yty-gpt-5.5=0.10 yty-gpt-6=0.10 lbl-gemini-3.7-flash=0.00 mean=0.07 ✗ multi-consensus misses
- "读取项目目录，查看目录内是否有文件" jev=0.09 jev=0.06 yty-gpt-5.6=0.15 yty-gpt-5.6-sol=0.10 yty-gpt-5.5=0.00 yty-gpt-6=0.00 lbl-gemini-3.7-flash=0.00 mean=0.05 ✗ multi-consensus misses
- "读取项目目录，看看有什么文件" jev=0.06 jev=0.06 yty-gpt-5.6=0.00 yty-gpt-5.6-sol=0.00 yty-gpt-5.5=0.00 yty-gpt-6=0.00 lbl-gemini-3.7-flash=0.00 mean=0.01 ✗ multi-consensus misses
- "Current runtime context. This snapshot supersedes " jev=0.43 jev=0.22 yty-gpt-5.6=0.00 yty-gpt-5.6-sol=0.00 yty-gpt-5.5=0.10 yty-gpt-6=0.00 lbl-gemini-3.7-flash=0.50 mean=0.14 ✗ multi-consensus misses
- "C:\Users\RongWu\AppData\Roaming\DSH Desktop\diagno" jev=0.28 jev=0.32 yty-gpt-5.6=0.35 yty-gpt-5.6-sol=0.20 yty-gpt-5.5=0.20 yty-gpt-6=0.25 lbl-gemini-3.7-flash=0.00 mean=0.22 ✗ multi-consensus misses
- "D:\AgentKHD  已经全部解压了" jev=0.34 jev=0.19 yty-gpt-5.6=0.65 yty-gpt-5.6-sol=0.55 yty-gpt-5.5=0.20 yty-gpt-6=0.70 lbl-gemini-3.7-flash=1.00 mean=0.55 ✓ multi-consensus catches
- "开始实行吧" jev=0.17 jev=0.28 yty-gpt-5.6=0.05 yty-gpt-5.6-sol=0.05 yty-gpt-5.5=0.10 yty-gpt-6=0.10 lbl-gemini-3.7-flash=0.00 mean=0.10 ✗ multi-consensus misses
- "<goal_round>
Objective: "在 D:\\AgentKHD 下创建独立于 DSH" jev=0.06 jev=0.06 yty-gpt-5.6=0.05 yty-gpt-5.6-sol=0.15 yty-gpt-5.5=0.10 yty-gpt-6=0.00 lbl-gemini-3.7-flash=0.00 mean=0.06 ✗ multi-consensus misses
