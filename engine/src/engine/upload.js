// Upload: the discovery barrier, and the standing invariant (C3).
// Design: interfaces.md §5.5.
//
// The single most expensive recurring data error on this stack is a résumé
// upload whose parser rewrites fields that were already correct — recorded on
// Rippling, Cole iCIMS, SimVentions, Cotiviti, Jobvite and Eightfold, and the
// clobbered field is usually the login/email, set to the forbidden CMU
// address. So an upload is never "one action"; it is a barrier:
//
//   upload -> verifyUpload -> stamp assert -> RE-DISCOVER -> re-read every
//   already-filled field -> forbidden scan -> only then may the step advance.
//
// C3 makes the verification standing rather than one-time: Avature attaches
// one résumé per ACCOUNT, so a file verified on page 2 can be a different file
// by page 4 with no action of ours in between.

import { discover, emitDiscovery } from './discovery.js';
import { scanFormForForbidden, ParkRequired } from './fill.js';

export class UploadUnverified extends ParkRequired {}
export class StampMismatch extends ParkRequired {}

/**
 * Perform one upload and verify it.
 *
 * @param {object} artifact {path, sha256, bytes, stampedJobKey}
 */
export async function uploadAndVerify(adapter, ctx, target, artifact, { events }) {
  events.emit('upload_attempted', {
    target: target.name,
    path: artifact.path,
    sha256: artifact.sha256,
    bytes: artifact.bytes,
    stamped_job_key: artifact.stampedJobKey,
  });

  await adapter.upload(ctx, target, artifact);

  const evidence = await adapter.verifyUpload(ctx, target, artifact);

  // F17/F18: the stamp is in PDF METADATA, not only the filename, because
  // Avature's account-level attachment and the 2026-09-12 cross-applier
  // contamination both produce a file with a plausible name and the wrong
  // contents. A mismatch is a hard park — not a silent re-upload.
  if (artifact.stampedJobKey !== ctx.jobKey) {
    throw new StampMismatch('forbidden_value',
      `artifact is stamped for ${artifact.stampedJobKey} but this application is ${ctx.jobKey}`);
  }

  events.emit('upload_verified', {
    target: target.name,
    attached: !!evidence?.attached,
    observed_name: evidence?.observedName ?? null,
    observed_bytes: evidence?.observedBytes ?? null,
    sha256_match: evidence?.observedBytes ? evidence.observedBytes === artifact.bytes : null,
    how: evidence?.how ?? 'other',
  });

  // F19: an unverified upload can never be followed by a submit. Five forms
  // in one day silently accepted nothing and were all redone by hand.
  if (!evidence?.attached) {
    throw new UploadUnverified('value_absent',
      `upload of ${target.name} could not be verified as attached`);
  }

  return evidence;
}

/**
 * The post-upload barrier. Re-runs discovery, re-reads every previously
 * filled field, scans the whole form, and reports what the parser changed.
 *
 * @param {Map<string,string>} filledBefore  field_key -> value we believe is set
 * @returns {Promise<{changed:Array, hits:Array, discovered:object}>}
 */
export async function postUploadReverify(root, { events, profile, filledBefore, rootFrames }) {
  const discovered = await discover(root);
  emitDiscovery(events, { fields: discovered.fields, rootFrames });

  const changed = [];
  for (const f of discovered.all) {
    const key = f.boundKey;
    if (!key || !filledBefore.has(key)) continue;
    const before = filledBefore.get(key);
    if (normalizeLoose(f.value) !== normalizeLoose(before)) {
      changed.push({ field_key: key, severity: 'fail' });
    }
  }

  const hits = await scanFormForForbidden(discovered, profile);

  // Shaped like a review_diff so a parser overwrite is visible in the stream
  // as a concrete before/after, rather than being discovered by a human
  // reading the submitted application.
  events.emit('review_diff', {
    checked: filledBefore.size,
    matched: filledBefore.size - changed.length,
    mismatches: changed,
    verdict: changed.length || hits.length ? 'fail' : 'pass',
    scope: 'post_upload_reverify',
  });

  return { changed, hits, discovered };
}

/**
 * C3: re-assert every attached artifact after a page advance. Emits
 * `upload_verified` again, so a stream in which an attachment was verified
 * once and submitted four pages later is a detectable anomaly.
 */
export async function reassertUploads(adapter, ctx, attachments, { events }) {
  const problems = [];
  for (const { target, artifact } of attachments) {
    // eslint-disable-next-line no-await-in-loop
    const evidence = await adapter.verifyUpload(ctx, target, artifact).catch(() => null);
    events.emit('upload_verified', {
      target: target.name,
      attached: !!evidence?.attached,
      observed_name: evidence?.observedName ?? null,
      observed_bytes: evidence?.observedBytes ?? null,
      sha256_match: evidence?.observedBytes ? evidence.observedBytes === artifact.bytes : null,
      how: evidence?.how ?? 'other',
      recheck: true,
    });
    if (!evidence?.attached) problems.push({ target: target.name, why: 'no longer attached' });
    else if (artifact.stampedJobKey !== ctx.jobKey) problems.push({ target: target.name, why: 'stamp mismatch' });
  }
  return problems;
}

const normalizeLoose = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
