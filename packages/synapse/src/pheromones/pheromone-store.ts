import type { PheromoneMark } from '../types'

export class InMemoryPheromoneStore {
  private readonly marks: PheromoneMark[] = []

  add(mark: PheromoneMark): void {
    this.marks.push(mark)
  }
}
