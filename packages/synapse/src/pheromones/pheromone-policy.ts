import type { PheromoneMark } from '../types'

export class PheromonePolicy {
  apply(_mark: PheromoneMark): PheromoneMark {
    return _mark
  }
}
