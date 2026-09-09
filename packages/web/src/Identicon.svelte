<script>
  import { agentColor, agentTint } from './format.js';

  let { nick = '', size = 28 } = $props();

  // A stable hash of the nick — same idea as the colour hash in format.js, a
  // few more bits because this drives 15 cells rather than one hue.
  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // 5×5 grid, left half + centre column decide the pattern, right half mirrors
  // it — the symmetry is what makes a random bitfield read as a "face".
  const cells = $derived.by(() => {
    const h = hash(nick || 'other');
    const out = [];
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 3; x += 1) {
        const bit = (h >>> (y * 3 + x)) & 1;
        if (!bit) continue;
        out.push([x, y]);
        if (x < 2) out.push([4 - x, y]);
      }
    }
    return out;
  });
</script>

<svg
  class="identicon"
  width={size}
  height={size}
  viewBox="0 0 5 5"
  shape-rendering="crispEdges"
  style:background={agentTint(nick, 0.16)}
  aria-hidden="true"
>
  {#each cells as [x, y] (x + '-' + y)}
    <rect {x} {y} width="1" height="1" fill={agentColor(nick)} />
  {/each}
</svg>

<style>
  .identicon {
    flex: none;
    border-radius: 30%;
    display: block;
  }
</style>
