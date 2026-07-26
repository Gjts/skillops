# SkillOps Domain Context

SkillOps turns privacy-minimized runtime facts and reproducible evaluation
results into honest, reversible decisions about immutable AI asset revisions.

## Language

### Runtime observation

**Runtime Event**:

An allowlisted metadata fact emitted or derived from a supported runtime
signal. Discovery and lifecycle activity are different facts.
_Avoid_: Execution proof, task result

**Verified Runtime**:

A healthy configured Runtime with qualifying post-boundary lifecycle evidence.
Installation or discovery alone is not verification.
_Avoid_: Installed Runtime, connected Runtime

**Terminal Run**:

A Skill lifecycle ending in `skill.completed` or `skill.failed`, together with
its bounded correlation view. It proves lifecycle termination, not task success.
_Avoid_: Successful run, task result

**Partial Source**:

A source whose valid prefix is available but whose final record is incomplete.
It is neither complete nor corrupt and must not be silently repaired by an
ordinary mutation.

### Artifact and evaluation

**Artifact Revision**:

One immutable source reference and content hash for a Skill, Prompt, Workflow,
Rule, Agent, or evaluation asset.
_Avoid_: Mutable branch head, working copy

**Candidate Draft**:

A memory-only Quick Compare continuation that carries immutable Artifact
references into a later Managed Suite. It is not a Capability.
_Avoid_: Candidate, Release Candidate

**Managed Suite**:

A versioned, reviewed set of synthetic or deliberately sanitized evaluation
cases. Runtime telemetry never becomes Suite input.

**Decision**:

The single final disposition of a completed Managed Suite run:
`create-candidate`, `keep-baseline`, `reject-candidate`, or
`collect-more-evidence`.
_Avoid_: Repeated click, provisional UI choice

**Evidence**:

An immutable sanitized Managed Suite result bound to exact Artifact, Suite,
dataset, policy, and run hashes.
_Avoid_: Runtime Event, raw model output, product RC verification

### Governance and release

**Candidate**:

A persisted metadata-only proposal for one exact Artifact Revision and release
target. Without a qualifying final Decision it cannot enter Ready or any release
stage.
_Avoid_: Candidate Draft, Release Candidate

**Release Candidate**:

A Candidate whose immutable origin is a Managed Suite run with a final
`create-candidate` Decision. Each later Evidence refresh requires its own final
`create-candidate` Decision without changing that origin.
_Avoid_: Evaluation challenger, product-version RC

**Approval**:

An attestation by a server-resolved reviewer principal distinct from the owner,
bound to the exact Release Candidate, Evidence, and policy.
_Avoid_: Owner acknowledgement, self-approval

**Canary**:

An approved Release Candidate deployed to an isolated target for verification.
It is not the current Stable.

**Stable**:

The current governed Artifact Revision for a release target, retaining a
traceable previous Stable for rollback.

### Product delivery

**Product RC Verification Record**:

The versioned packet of automated and attributable human evidence for releasing
SkillOps itself. It is not evaluation Evidence or a governed Release Candidate.
_Avoid_: Release Candidate evidence
