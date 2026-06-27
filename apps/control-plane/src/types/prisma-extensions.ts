import { Prisma } from '@prisma/client'

export type ProjectWithRelations = Prisma.ProjectGetPayload<{
  include: { missions: true; events: true }
}>

export type MissionWithProject = Prisma.MissionGetPayload<{
  include: { project: true }
}>

export type EventWithProject = Prisma.EventGetPayload<{
  include: { project: true }
}>
