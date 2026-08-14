import { WORLD_DEFS } from "./feature-config.js";

export function getWorldMapState({ progress = 0, clearedLevels = {} } = {}) {
  return WORLD_DEFS.map((world, worldIndex) => {
    const unlocked = progress >= world.unlockAt;
    const nodes = world.nodes.map((label, nodeIndex) => {
      const levelIndex = worldIndex * 5 + nodeIndex;
      const stars = Number(clearedLevels[levelIndex] || 0);
      const available = unlocked && levelIndex <= progress + 1;
      return {
        id: `${world.id}-${nodeIndex}`,
        label,
        levelIndex,
        stars,
        cleared: stars > 0,
        available,
        boss: nodeIndex === world.nodes.length - 1,
      };
    });
    return { ...world, unlocked, nodes };
  });
}

export function getWorldForLevel(levelIndex) {
  const index = Math.max(0, Number(levelIndex) || 0);
  return WORLD_DEFS[Math.floor(index / 5)] || WORLD_DEFS[WORLD_DEFS.length - 1];
}
