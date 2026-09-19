// Day keys are PIPELINE days, not UTC days.
//
// Droplet Gate 1 finding (2026-09-18): the `run` envelope field and
// walls.json first_seen/last_seen were derived from toISOString(), i.e. the
// UTC calendar — but resume-drops day folders, the ledger, and the hub-side
// (tenant, job-id) claim record are all keyed to the pipeline's local day.
// Any run after 17:00 PT therefore landed in a DIFFERENT day bucket from its
// own ledger (a ~19:00 PT run on 09-18 was stamped 2026-09-19).
//
// Rule: a value that names a BUCKET shared with the ledger (run day, wall
// first/last_seen) uses pipelineDay(); a value that names an INSTANT
// (event ts, solved_at, probed_at, generated) stays full UTC ISO, which is
// unambiguous and needs no zone bookkeeping.

export const PIPELINE_TZ = 'America/Los_Angeles';

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: PIPELINE_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});

/** The pipeline-day (YYYY-MM-DD in PIPELINE_TZ) containing `date`. */
export function pipelineDay(date = new Date()) {
  return fmt.format(date);
}
