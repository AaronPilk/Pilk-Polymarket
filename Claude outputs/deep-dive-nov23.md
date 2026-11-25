# Deep dive: what all the data says (Nov 23, 2026, 11 PM)

This covers everything we have:
- **Live paper bets:** the first day of them (807 Bitcoin bets since 10:20 PM on Nov 22, plus 39 sports bets).
- **Window marks:** the bot's 30-second marks on 536 settled Bitcoin windows.
- **Per-second record:** about 6 hours of it (5 PM to 11 PM tonight).
- **Replays:** 30 days of Bitcoin, Gold and XRP history, and 4,079 basketball games.

## The short version

1. **Nothing has an edge yet.** The Bitcoin bot is up $7.09 on 807 bets, but that's within normal luck. The "is it luck?" test scores it 0.3, and 2 is the usual bar.
2. **Polymarket's short Bitcoin markets are hard to beat.** The math, chart rules, early exits, selling half and speed have all failed against the market's own prices once fees are counted.
3. **Speed isn't an edge either, as far as we can measure.** The per-second record shows Polymarket's price moving in the same second as ours, and sometimes a second before. When our math jumped and the market didn't follow, the market was right.
4. **Early exits cost money.** Selling early instead of holding to the result gave up $13 on 171 sales.
5. **The most plausible edges left:**
   - Avoid fees by selling with resting orders (they pay no fee).
   - Your own game reads in sports, which a rule can't copy but we can measure.
   - The 98¢ favorite, which is real on paper but tiny.

## 1. The Bitcoin bot's first full day

807 bets were closed or settled between 10:20 PM Nov 22 and 10:40 PM Nov 23:
- $340 staked
- $13.22 in fees
- +$7.09 profit

That's +0.9¢ a bet with a 37¢ swing per bet. Hours move together, so grouping bets by hour is the honest test. On that basis the result scores t 0.28, which is noise.

| Strategy | Bets | Profit | Per $ bet |
|---|---|---|---|
| Price vs math family (early, 4+ min left) | 637 | +$6.54 | +3.1% |
| Price vs math family (late) | 12 | +$1.33 | +13.5% |
| Beat the lag | 25 | +$2.63 | +21% |
| 98¢ favorite | 90 | −$1.40 | −1.6% |
| 95–98¢ favorites (retired early) | 13 | +$0.49 | +3.9% |
| Price ladder (retired tonight) | 30 | −$2.50 | −31.7% |

None of the slices hold up:
- **By price paid:**
  - Under 20¢: +$5.28 on 121 bets
  - 20–40¢: −$2.57 on 390
  - 40–60¢: +$10.25 on 119
  - 60–80¢: −$4.22 on 30
  - 95¢ and up: −$0.91 on 103

  No pattern a theory would predict, and each slice is small.
- **By window length:**
  - 5-minute: +$5.75 on 393 bets
  - 15-minute: +$0.85 on 301
  - Hourly: +$2.99 on 83
- **By hour of day:** big swings that cancel out, like 5 AM +$12.94 and 9 AM −$11.27. That's what noise looks like.

**Data quality changed during the day, which muddies the early results.**
- Until 6:13 PM, every price connection dropped and reconnected about every 10 seconds.
- After the fix, the signals that trigger the price-vs-math bets came in at less than half of the previous night's rate for the same hours. So some of the early signals, and some of the early profit, likely came from glitchy data.
- Coinbase reached the bot only part of the time until the 10:15 PM fix. Since then it's there every second.

## 2. Selling early vs holding

The bot already records what every early sale got against what holding would have paid.

| | Sold early | Losers sold (saved) | Winners sold (gave up) | Net vs holding |
|---|---|---|---|---|
| Price vs math family | 171 | +$24.76 | −$37.76 | **−$13.00** |
| Beat the lag | 3 | — | −$0.90 | −$0.90 |

It matches the replays. A contract that has run up is priced about right, so selling it is worth the same as holding, minus the sell fee and the bid/ask gap. Tonight's sell-half replay found the same thing on 30 days of Bitcoin and Gold.

## 3. The math vs the market

The bot's 30-second marks give one reading per window, early and late. Each reading compares the math, the market and what happened. Only marks with a book 3¢ wide or tighter were used.

- **When they agree within 5 points,** they're equally good. That's 444 early windows, with the same score of 0.682 for both.
- **When they disagree, the market is usually closer.**

| When the math was… | Windows | Market said | Math said | Up actually won |
|---|---|---|---|---|
| 5–15 pts below the market (early) | 39 | 62% | 55% | 67% |
| 5–15 pts above the market (early) | 48 | 41% | 48% | 40% |
| 5–15 pts above the market (late) | 83 | 34% | 41% | 31% |
| 15+ pts above the market (late) | 10 | 22% | 45% | 20% |

The bot's own grading agrees: the market predicts better than the math in both bands.
- **4+ minutes left:** market score 0.572 vs math 0.584, over 524 windows.
- **Under 4 minutes:** market 0.386 vs math 0.408, over 452 windows.

Lower is better. So betting on the math's disagreements is betting against the better forecaster.

## 4. Speed: is the market slower than us?

This is what the per-second record was for. Three tests, all on Polymarket's 5- and 15-minute windows:

1. **Who moves first, second by second.** This covers about 13,600 one-second pairs on 5-minute windows. The math's moves and the market's moves line up in the same second (correlation 0.72). The market moving a second before the math is 0.11, and a second after is 0.03. So the market is as fast as our price or a hair faster. Its market makers watch exchange feeds at least as quick as ours.
2. **After a jump.** There were 500 times the math moved 5+ points in 10 seconds. In those same 10 seconds the market had already moved as much or more (on average 8.7 points against the math's 8.4), and it didn't keep going afterward. Buying at the jump and selling 30 seconds later lost 5–7¢ a trade.
3. **The setups beat the lag looks for.** The math moved 6+ points in 30 seconds while the market moved less than 2. There were 55 of these (30 on 5-minute windows, 25 on 15-minute).
   - The market didn't catch up. A minute later it had drifted slightly the other way.
   - Holding those bets to the end lost 7.4¢ a bet on 5-minute windows and 12.8¢ on 15-minute.
   - When the math jumps and the market doesn't, the market is usually right.

Beat the lag is still +$2.63 on 25 live bets, but it hasn't bet since 6 PM, and this record gives no reason to expect it to keep winning. It's only 6 hours of data, and Coinbase was only fully in for the last 45 minutes, so this gets rerun as the record grows. The direction is clear, though.

## 5. Sports

- **Live paper bets:** 39, −$0.32. The swing strategy is ahead (+$0.54 on 11) and the value strategy behind (−$1.04 on 8). All far too few to judge.
- **Tonight's flip replay** (4,079 NBA and college games, January–June): cashing out the underdog's run and backing the favorite loses about the fees. After the run, the favorite is priced right: after a 15-point run it cost 52¢ and won 52% of the time.
- **Your own trades** remain the one spot with a sign of a real edge. In the first half, your buys of trailing teams you expected to win bounced to double about twice as often as the price said (23 buys, 11 games). Late cheap swings were the opposite. The comeback and trailer strategies test that read, with only a handful of games so far.

## 6. What 30 days of replays have ruled out

| Idea | Result |
|---|---|
| Price vs math with exits (Bitcoin) | −2.8¢ a contract, 2,488 bets |
| Cheap side | −5.3¢ |
| Strict math | +1.9¢, 352 bets, not distinguishable from luck (halves +5.3 / −4.5) |
| Resting buys at the bid | −10¢ a fill: they fill right before the price goes against you |
| 98¢ favorite | **+0.5¢ a bet over 1,868, the only solid result**, tiny |
| XRP (any rule) | no edge; spreads 4× Bitcoin's |
| Sell half at a double (Bitcoin, Gold) | price at the double is fair; costs a fee |
| Chart rules (breakouts, trend, RSI, streaks) | following breakouts loses; fading is break-even after fees |
| Flip to the favorite after a run (basketball) | the favorite is priced right; loses the fees |

## 7. Where an edge could still come from

1. **Pay fewer fees.** A round trip costs about 4–5¢ at mid prices. The strict strategy's entries do come before the price moves its way: the market moves about 5¢ in the next minute (t 2.4, the one timing result on the board unlikely to be luck). Today that move is spent on fees. A version that sells with a resting order a few cents up pays no fee on the sale and might keep part of it. The per-second record can replay that before anything goes live.
2. **Your reads.** The sports edge, if there is one, is in choosing the game. The dashboard already syncs your trades. Scoring each of your entries against the market price at that moment, and the result, would show whether your reads beat the price and in which spots. Then a rule can copy the parts that work.
3. **Better data.** Our price trails the market by a hair. Matching the market makers would take faster exchange feeds than Cloudflare Workers can reach well today. That's the hardest of the three.

## 8. What I'd do next

1. **Don't put money on any Bitcoin strategy.** Nothing has passed. The readiness card agrees.
2. **Keep the bot running as a cheap data collector.** Keep 1-contract tests, the per-second record, and the board retiring what loses.
3. **Replay "take on the signal, exit with a resting order"** on the per-second record once there are 2–3 days of it.
4. **Score your own trades against the market** going forward, to find the reads worth turning into rules.
5. **Keep the 98¢ favorite at 1 contract.** It's the only replay-positive rule. One loss wipes out about 50 wins, so it can't size up without a long record.
6. **Rerun the speed tests weekly** as the per-second record grows.
7. **Hold new ideas to the same path:** replay first, then 1-contract paper, then live. Tonight that path tested three new ideas in an evening without risking a dollar.

*Notes: all P&L is paper, per contract, with Polymarket US taker fees (0.095 × p × (1 − p)). "t" is the luck test: around 2 or more in both halves of the data is the bar for "probably real". The queries behind every number are in the D1 database and the replay scripts in `scripts/`.*
