<script lang="ts">
  import type { WorkspaceMarker } from '@techpulse/contracts';

  const workspace: WorkspaceMarker = { package: '@techpulse/contracts' };
</script>

<svelte:head>
  <title>TechPulse</title>
</svelte:head>

<main>
  <h1>TechPulse</h1>
  <p>Workspace ready: {workspace.package}</p>
</main>
