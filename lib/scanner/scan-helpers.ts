/**
 * Whether to reassign a file's canonical component owner.
 * @param currentConf     current assignment confidence (0–100)
 * @param newConf         new candidate confidence (0–100)
 * @param scansSinceMove  number of scans elapsed since the last reassignment
 */
export function shouldReassign(currentConf: number, newConf: number, scansSinceMove: number): boolean {
  const gap = newConf - currentConf
  if (gap <= 25) return false
  if (gap > 50) return true          // obvious wrong case — override cooldown
  return scansSinceMove >= 3          // normal reassignment requires cooldown
}

/**
 * Whether a component should be marked as unstable.
 */
export function isComponentUnstable(reassignmentCount: number, avgConfidence: number): boolean {
  return reassignmentCount > 3 || avgConfidence < 40
}
