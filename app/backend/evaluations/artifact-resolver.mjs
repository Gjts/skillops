import { normalizeArtifactSourceReference } from '../../shared/evaluation-schema.mjs'
import { discoverCandidateArtifact, installedArtifactDefinitions } from './candidate-source.mjs'
import { EvaluationError } from './errors.mjs'
import { gitArtifactSource } from './git-artifact-source.mjs'
import { promptRegistry } from '../prompts/prompt-registry.mjs'
import { initializePromptHubConnector } from '../prompts/prompthub-connector.mjs'

function reference(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4_000) throw new EvaluationError('Artifact reference is invalid.', 422)
  return value.trim()
}

export function createArtifactResolver(options = {}) {
  return {
    async resolve(value, context = {}) {
      const sourceRef = reference(value)
      if (sourceRef.startsWith('local-scan:')) {
        const definition = (await installedArtifactDefinitions(options)).find((item) => item.artifact?.sourceRef === sourceRef)
        if (!definition) throw new EvaluationError('The local artifact reference is not in the enabled scanned inventory.', 404)
        return definition
      }
      if (sourceRef.startsWith('git:')) {
        const source = options.gitArtifactSource || gitArtifactSource(options)
        const result = await source.resolveArtifact(sourceRef)
        if (context.expectedContentHash && result.artifact.contentHash !== context.expectedContentHash) {
          throw new EvaluationError('The Git Artifact no longer matches its recorded content hash.', 409)
        }
        return result
      }
      if (sourceRef.startsWith('github:')) {
        let coordinates
        try { coordinates = normalizeArtifactSourceReference(sourceRef, 'github').slice('github:'.length) } catch (error) {
          throw new EvaluationError(error instanceof Error ? error.message : 'GitHub artifact reference is invalid.', 422)
        }
        const separator = coordinates.lastIndexOf('#')
        if (separator < 1 || separator === coordinates.length - 1) throw new EvaluationError('GitHub artifact reference is invalid.', 422)
        const sourceUrl = coordinates.slice(0, separator)
        let candidatePath
        try { candidatePath = decodeURIComponent(coordinates.slice(separator + 1)) } catch {
          throw new EvaluationError('GitHub artifact reference path is invalid.', 422)
        }
        const result = await discoverCandidateArtifact({ sourceUrl, candidatePath }, options)
        if (context.expectedContentHash && result.definition.artifact.contentHash !== context.expectedContentHash) {
          throw new EvaluationError('The GitHub artifact no longer matches its recorded content hash.', 409)
        }
        return result.definition
      }
      if (sourceRef.startsWith('prompt-registry:')) {
        if (typeof options.resolvePromptRegistryArtifact === 'function') return options.resolvePromptRegistryArtifact(sourceRef, context)
        return promptRegistry(options).resolveArtifact(sourceRef)
      }
      if (sourceRef.startsWith('prompthub:')) {
        if (typeof options.resolvePromptHubArtifact === 'function') return options.resolvePromptHubArtifact(sourceRef, context)
        const version = await initializePromptHubConnector(options).getVersion(sourceRef)
        if (context.expectedContentHash && version.artifact.contentHash !== context.expectedContentHash) {
          throw new EvaluationError('The PromptHub Artifact no longer matches its recorded content hash.', 409)
        }
        return { artifact: version.artifact, prompt: version.prompt }
      }
      throw new EvaluationError('Artifact reference source is unsupported.', 422)
    },
  }
}
