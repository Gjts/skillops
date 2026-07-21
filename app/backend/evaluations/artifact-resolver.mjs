import { discoverCandidateArtifact, installedDefinitions } from './candidate-source.mjs'
import { EvaluationError } from './errors.mjs'
import { promptRegistry } from '../prompts/prompt-registry.mjs'

function reference(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4_000) throw new EvaluationError('Artifact reference is invalid.', 422)
  return value.trim()
}

export function createArtifactResolver(options = {}) {
  return {
    async resolve(value, context = {}) {
      const sourceRef = reference(value)
      if (sourceRef.startsWith('local-scan:')) {
        const definition = (await installedDefinitions(options)).find((item) => item.artifact?.sourceRef === sourceRef)
        if (!definition) throw new EvaluationError('The local artifact reference is not in the enabled scanned inventory.', 404)
        return definition
      }
      if (sourceRef.startsWith('github:')) {
        const coordinates = sourceRef.slice('github:'.length)
        const separator = coordinates.lastIndexOf('#')
        if (separator < 1 || separator === coordinates.length - 1) throw new EvaluationError('GitHub artifact reference is invalid.', 422)
        const sourceUrl = coordinates.slice(0, separator)
        const candidatePath = coordinates.slice(separator + 1)
        const result = await discoverCandidateArtifact({ sourceUrl, candidatePath }, options)
        if (result.definition.artifact.sourceRef !== sourceRef) throw new EvaluationError('The GitHub artifact no longer matches its reference.', 409)
        return result.definition
      }
      if (sourceRef.startsWith('prompt-registry:')) {
        if (typeof options.resolvePromptRegistryArtifact === 'function') return options.resolvePromptRegistryArtifact(sourceRef, context)
        return promptRegistry(options).resolveArtifact(sourceRef)
      }
      throw new EvaluationError('Artifact reference source is unsupported.', 422)
    },
  }
}
