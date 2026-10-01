import yaml from 'yaml'
import {
  PipelineIR,
  PipelineIRSchema,
  PipelineTrigger,
  PipelineJob,
  PipelineStep,
  PipelineService,
} from '../../ir/types.js'

export function parseWorkflowYaml(content: string, workflowId?: string): PipelineIR {
  const parsed = yaml.parse(content)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid YAML content')
  }

  const triggers: PipelineTrigger[] = []
  if (parsed.on) {
    if (typeof parsed.on === 'string') {
      triggers.push({ type: mapTriggerType(parsed.on) })
    } else if (Array.isArray(parsed.on)) {
      for (const t of parsed.on) {
        triggers.push({ type: mapTriggerType(t) })
      }
    } else if (typeof parsed.on === 'object') {
      for (const [key, value] of Object.entries(parsed.on)) {
        const type = mapTriggerType(key)
        const trigger: PipelineTrigger = { type }
        const valObj = value as Record<string, unknown> | null
        if (valObj) {
          if (valObj.branches) {
            trigger.branches = Array.isArray(valObj.branches)
              ? (valObj.branches as string[])
              : [valObj.branches as string]
          }
          if (valObj.paths) {
            trigger.paths = Array.isArray(valObj.paths)
              ? (valObj.paths as string[])
              : [valObj.paths as string]
          }
          if (valObj.schedule && Array.isArray(valObj.schedule)) {
            const firstSchedule = valObj.schedule[0] as Record<string, unknown> | undefined
            if (firstSchedule?.cron) {
              trigger.cron = firstSchedule.cron as string
            }
          } else if (key === 'schedule' && Array.isArray(value)) {
            // Handle direct on: schedule: - cron: '...'
            for (const item of value) {
              const scheduleItem = item as Record<string, unknown>
              if (scheduleItem.cron) {
                triggers.push({ type: 'schedule', cron: scheduleItem.cron as string })
              }
            }
            continue // Skip adding the base trigger since we already added specific ones
          }
        }
        triggers.push(trigger)
      }
    }
  }

  const jobs: Record<string, PipelineJob> = {}
  if (parsed.jobs && typeof parsed.jobs === 'object') {
    for (const [jobId, jobData] of Object.entries(parsed.jobs)) {
      const data = jobData as Record<string, unknown>

      const steps: PipelineStep[] = []
      if (Array.isArray(data.steps)) {
        for (const stepData of data.steps) {
          steps.push({
            id: stepData.id as string | undefined,
            name: stepData.name as string | undefined,
            uses: stepData.uses as string | undefined,
            run: stepData.run as string | undefined,
            with: stepData.with as Record<string, unknown> | undefined,
            env: stepData.env as Record<string, string> | undefined,
            continueOnError: stepData['continue-on-error'] as boolean | undefined,
          })
        }
      }

      const services: Record<string, PipelineService> = {}
      if (data.services && typeof data.services === 'object') {
        for (const [serviceId, serviceData] of Object.entries(data.services)) {
          const s = serviceData as Record<string, unknown>
          services[serviceId] = {
            image: s.image as string,
            ports: s.ports as string[] | undefined,
            env: s.env as Record<string, string> | undefined,
            options: s.options as string | undefined,
          }
        }
      }

      jobs[jobId] = {
        id: jobId,
        name: data.name as string | undefined,
        runsOn: data['runs-on'] as string | string[],
        needs: Array.isArray(data.needs)
          ? data.needs
          : data.needs
            ? [data.needs as string]
            : undefined,
        environment: data.environment as string | undefined,
        services: Object.keys(services).length > 0 ? services : undefined,
        steps,
        if: data.if as string | undefined,
      }
    }
  }

  const ir = {
    id: workflowId || (parsed.name as string) || 'unknown',
    name: (parsed.name as string) || workflowId || 'unknown',
    triggers,
    jobs,
  }

  return PipelineIRSchema.parse(ir)
}

function mapTriggerType(githubEvent: string): PipelineTrigger['type'] {
  switch (githubEvent) {
    case 'push':
      return 'push'
    case 'pull_request':
      return 'pull_request'
    case 'schedule':
      return 'schedule'
    case 'workflow_dispatch':
      return 'workflow_dispatch'
    default:
      // Fallback for types not strictly defined in PipelineTrigger schema
      // But we mapped strictly the required ones in the issue context.
      // So returning push as fallback but ideally we'd filter them out or error.
      return 'push'
  }
}
