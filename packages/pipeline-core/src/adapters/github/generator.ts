import yaml from 'yaml'
import { PipelineIR } from '../../ir/types.js'

export function generateWorkflowYaml(ir: PipelineIR): string {
  const on: Record<string, unknown> = {}

  for (const trigger of ir.triggers) {
    const triggerData: Record<string, unknown> = {}
    if (trigger.branches && trigger.branches.length > 0) {
      triggerData.branches = trigger.branches
    }
    if (trigger.paths && trigger.paths.length > 0) {
      triggerData.paths = trigger.paths
    }

    if (trigger.type === 'schedule' && trigger.cron) {
      if (!on.schedule) {
        on.schedule = []
      }
      ;(on.schedule as Array<{ cron: string }>).push({ cron: trigger.cron })
    } else {
      if (Object.keys(triggerData).length > 0) {
        on[trigger.type] = triggerData
      } else {
        // Default to null/empty representation if no specific branches or paths
        on[trigger.type] = null
      }
    }
  }

  const jobs: Record<string, unknown> = {}
  for (const [jobId, job] of Object.entries(ir.jobs)) {
    const jobData: Record<string, unknown> = {
      'runs-on': job.runsOn,
      steps: job.steps.map((step) => {
        const stepData: Record<string, unknown> = {}
        if (step.id) stepData.id = step.id
        if (step.name) stepData.name = step.name
        if (step.uses) stepData.uses = step.uses
        if (step.run) stepData.run = step.run
        if (step.with && Object.keys(step.with).length > 0) stepData.with = step.with
        if (step.env && Object.keys(step.env).length > 0) stepData.env = step.env
        if (step.continueOnError !== undefined) stepData['continue-on-error'] = step.continueOnError
        return stepData
      }),
    }

    if (job.name) jobData.name = job.name
    if (job.needs && job.needs.length > 0) jobData.needs = job.needs
    if (job.environment) jobData.environment = job.environment
    if (job.if) jobData.if = job.if

    if (job.services && Object.keys(job.services).length > 0) {
      const servicesData: Record<string, unknown> = {}
      for (const [serviceId, service] of Object.entries(job.services)) {
        const sData: Record<string, unknown> = { image: service.image }
        if (service.ports && service.ports.length > 0) sData.ports = service.ports
        if (service.env && Object.keys(service.env).length > 0) sData.env = service.env
        if (service.options) sData.options = service.options
        servicesData[serviceId] = sData
      }
      jobData.services = servicesData
    }

    jobs[jobId] = jobData
  }

  const workflow: Record<string, unknown> = {
    name: ir.name,
    on,
    jobs,
  }

  return yaml.stringify(workflow)
}
