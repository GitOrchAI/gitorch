import type { ClaimLease } from '../types'

export class ClaimManager {
  acquire(_lease: ClaimLease): ClaimLease {
    return _lease
  }
}
