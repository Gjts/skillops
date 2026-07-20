import type { MessageKey } from './messages'

export const demoDescriptionKeys: Partial<Record<string, MessageKey>> = {
  'database-migration': 'demo.skill.databaseMigration',
  'frontend-builder': 'demo.skill.frontendBuilder',
  'test-generator': 'demo.skill.testGenerator',
  'security-review': 'demo.skill.securityReview',
}

export const demoErrorKeys: Partial<Record<string, MessageKey>> = {
  'Assertion mismatch in 2 tests': 'demo.error.assertionMismatch',
  'Type check failed': 'demo.error.typeCheckFailed',
  'Tool permission denied': 'demo.error.toolPermissionDenied',
}
