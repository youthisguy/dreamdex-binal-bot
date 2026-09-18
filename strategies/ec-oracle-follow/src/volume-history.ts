/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Rolling volume baseline for the volume-confirmation gate (index.ts). Kept
// as its own ring rather than folded into SpotHistory: volatility (how much
// PRICE moved) and volume (how much SIZE traded) are different failure
// modes and don't need the same lookback to be a meaningful baseline — see
// OF_VOLUME_WINDOW_MS vs OF_VOL_WINDOW_MS in index.ts.

export class VolumeHistory {
    private readonly samples = new Map<string, { v: number; at: number }[]>();
  
    constructor(private readonly retainMs: number) {}
  
    /** Record an observation, dropping anything past the retention horizon. */
    record(asset: string, volume: number, atMs: number): void {
      if (!(volume >= 0)) return;
      const arr = this.samples.get(asset) ?? [];
      arr.push({ v: volume, at: atMs });
      const cutoff = atMs - this.retainMs;
      while (arr.length > 0 && arr[0]!.at < cutoff) arr.shift();
      this.samples.set(asset, arr);
    }
  
    /** Rolling average volume over the retention window, or null if warming up. */
    baseline(asset: string): number | null {
      const arr = this.samples.get(asset);
      if (!arr || arr.length < 2) return null; // not enough history to trust yet
      const sum = arr.reduce((s, x) => s + x.v, 0);
      return sum / arr.length;
    }
  }