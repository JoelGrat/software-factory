import type { PropagationItem } from './types'

export class PropagationManager {
  private queue: PropagationItem[] = []
  private visited: Set<string> = new Set()  // 'filePath::symbolName'
  private addedFiles: Set<string> = new Set()
  private readonly cap: number

  constructor(cap: number) {
    this.cap = cap
  }

  private visitedKey(filePath: string, symbolName: string): string {
    return `${filePath}::${symbolName}`
  }

  enqueue(item: PropagationItem): boolean {
    const key = this.visitedKey(item.filePath, item.symbolName)
    if (this.visited.has(key)) return false
    if (this.queue.length >= this.cap) return false
    this.queue.push(item)
    this.addedFiles.add(item.filePath)
    return true
  }

  markVisited(filePath: string, symbolName: string): void {
    this.visited.add(this.visitedKey(filePath, symbolName))
  }

  dequeue(): PropagationItem | null {
    return this.queue.shift() ?? null
  }

  size(): number {
    return this.queue.length
  }

  isAtCap(): boolean {
    return this.queue.length >= this.cap
  }

  getAddedFilePaths(): string[] {
    return Array.from(this.addedFiles)
  }

  isEmpty(): boolean {
    return this.queue.length === 0
  }
}
