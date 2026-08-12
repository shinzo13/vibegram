<script>
  import { agentColor, agentTint } from './format.js';
  import Self from './Tree.svelte';

  let { nodes = [], depth = 0 } = $props();
</script>

{#each nodes as node (node.path)}
  <div
    class="row"
    style:padding-left="{6 + depth * 14}px"
    style:background={node.heldHere ? agentTint(node.heldBy, 0.08) : null}
  >
    <span
      class="name"
      class:dir={node.path.endsWith('/')}
      class:untracked={!node.tracked}
      class:held={node.heldHere}
      style:color={node.heldBy ? agentColor(node.heldBy, !node.heldHere) : null}
    >
      {node.name}{node.path.endsWith('/') ? '/' : ''}
    </span>
    {#if node.heldHere}
      <span class="badge" style:color={agentColor(node.heldBy)} style:background={agentTint(node.heldBy, 0.14)}>
        {node.heldBy}
      </span>
    {/if}
  </div>
  {#if node.children.length > 0}
    <Self nodes={node.children} depth={depth + 1} />
  {/if}
{/each}

<style>
  .row {
    display: flex;
    gap: 8px;
    align-items: baseline;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 12.5px;
    line-height: 1.75;
    border-radius: 3px;
  }

  .name {
    white-space: nowrap;
  }

  .name.dir {
    color: #c3c7cf;
  }

  .name:not(.dir) {
    color: #7c828d;
  }

  /* A claim set on this very path, as opposed to one inherited from a parent. */
  .name.held {
    font-weight: 500;
  }

  /* On someone's disk but not in git — work happening right now. */
  .name.untracked {
    font-style: italic;
  }

  .badge {
    font-size: 10.5px;
    padding: 0 5px;
    border-radius: 3px;
    white-space: nowrap;
  }
</style>
