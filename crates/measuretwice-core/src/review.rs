// SPDX-License-Identifier: Apache-2.0
//! The shadow review export: which shadow cases one human must review.
//!
//! One shadow run records the new outcome beside the existing decision of
//! the host, and no report field combines the two, as the run report
//! contract states. This module owns the export step that follows: it
//! selects the stored shadow reports that need one human review and returns
//! them as review records, as MVP_SPEC.md section 10 requires.
//!
//! The host owns the meaning of its own decision vocabulary, so the
//! comparison never guesses. [`BaselineMeaning`] names what one host
//! decision word means: `pass`, `fail`, `review`, or `silent`. The host
//! states one meaning per word of its vocabulary, and
//! [`parse_baseline_meanings`] owns that boundary. One silent baseline
//! reads as one absent decision, not as one wrong decision, as MVP_SPEC.md
//! section 13 states.
//!
//! [`export_reviews`] then classifies every stored report through one fixed
//! rule order:
//!
//! 1. One candidate aggregate outcome of `error` exports the report as
//!   `candidate_error`, whatever its baseline states, because the run
//!   measured no decision.
//! 2. One report without one baseline exports as `missing_baseline`,
//!   because no comparison is possible.
//! 3. One stated meaning that differs from the candidate aggregate outcome
//!   exports as `disagreement`. One silent meaning matches one pass
//!   aggregate alone.
//! 4. Every other report is one agreement. Agreements enter the export
//!   through one reproducible sample alone, so baseline passes and silent
//!   baseline cases stay auditable and not only suspicious cases reach one
//!   reviewer.
//!
//! The sample is deterministic. Every agreement is ranked by the SHA-256 of
//! the seed, the case identifier, and the input hash. The first agreements
//! in rank order, up to the stated size, are selected. The same inputs
//! always select the same records, in report order, so the export retains
//! its sampling provenance: the seed, the algorithm, the sizes, the
//! inclusion rules, and the stated baseline meanings travel inside the
//! result.
//!
//! The export holds no raw case content. Every record states the stable
//! case identifier, the input hash, the run identifier, the host snapshot
//! reference when the run stated one, the recorded baseline with its
//! meaning, and the candidate outcomes. Baseline agreement stays one
//! observation: no field of the result states one accuracy or one
//! correctness claim.
//!
//! [`validate_review_labels`] closes the loop when the human labels
//! return. Each returned line states one case identifier of the export,
//! one expected-label object, and one label provenance record. The
//! validation checks every reference against the meaning of its check,
//! exactly as the dataset loader does, and keeps the provenance counts that
//! separate human judgments from model proposals. The validation reads no
//! baseline and computes no agreement, because baseline agreement is not
//! correctness: one label that contradicts the baseline outcome is one
//! valid label, and the host keeps the case content, which never crosses
//! this boundary.

use crate::dataset::{
    parse_expected_at, parse_label_at, validate_record_labels, CaseRecord, ExpectedLabels,
    LabelAuthor, LabelFinding, LabelProvenance,
};
use crate::definition::ValidatedDefinition;
use crate::error::{fragment, ReasonCode, ValidationError};
use crate::report::{AggregateOutcome, CompletionStatus, Outcome, RunMode, RunReport};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

/// The greatest number of sampled agreements one export states.
pub const MAX_SAMPLED_AGREEMENTS: usize = 100_000;

/// The greatest length of one sampling seed, in characters.
pub const MAX_SEED_CHARS: usize = 128;

/// The word that names the sampling algorithm of the export.
pub const SAMPLE_ALGORITHM: &str = "sha256_rank";

/// The standing statement that one review selection states no accuracy.
pub const NO_ACCURACY_CLAIM: &str = "Baseline agreement is not correctness. These records select cases for review. They state no accuracy and no correctness claim.";

/// The standing statement that the label validation reads no baseline.
pub const NO_BASELINE_AUTHORITY: &str = "Baseline agreement decided nothing here. The validation compared each label with the meaning of its check alone. The recorded baseline of the exported record is no reference answer.";

/// The standing statement that only reviewed labels are reviewed evidence.
pub const ONLY_REVIEWED_LABELS: &str = "Only reviewed labels are reviewed evidence. One model proposal that no human reviewed stays a proposal.";

/// What one word of the host decision vocabulary means.
///
/// The host states one meaning for every baseline outcome word its decision
/// path produces. `pass`, `fail`, and `review` name the aggregate outcome
/// vocabulary of the run report. `silent` names one absent decision: the
/// existing path proposed nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BaselineMeaning {
    /// The existing decision accepts the case.
    Pass,
    /// The existing decision rejects the case.
    Fail,
    /// The existing decision defers the case to one human.
    Review,
    /// The existing decision path decided nothing.
    Silent,
}

impl BaselineMeaning {
    /// Returns the contract word of this meaning.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pass => "pass",
            Self::Fail => "fail",
            Self::Review => "review",
            Self::Silent => "silent",
        }
    }

    /// Returns the meaning of one contract word, or `None` for any other
    /// text.
    pub fn from_word(word: &str) -> Option<Self> {
        match word {
            "pass" => Some(Self::Pass),
            "fail" => Some(Self::Fail),
            "review" => Some(Self::Review),
            "silent" => Some(Self::Silent),
            _ => None,
        }
    }

    /// Returns true when one candidate aggregate outcome with this stated
    /// meaning is one agreement.
    ///
    /// One silent baseline matches one pass aggregate alone, because both
    /// propose nothing. Every other meaning matches its own aggregate word.
    /// One error aggregate never reaches this comparison.
    pub fn agrees_with(self, aggregate: AggregateOutcome) -> bool {
        let effective = match self {
            Self::Silent => Self::Pass,
            other => other,
        };
        match aggregate {
            AggregateOutcome::Pass => effective == Self::Pass,
            AggregateOutcome::Fail => effective == Self::Fail,
            AggregateOutcome::Review => effective == Self::Review,
            AggregateOutcome::Error => false,
        }
    }
}

/// Why one stored shadow report entered the review export.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SelectionReason {
    /// The stated baseline meaning differs from the candidate aggregate
    /// outcome.
    Disagreement,
    /// The meanings agree and the seeded sample selected the report.
    SampledAgreement,
    /// The report states no baseline, so no comparison is possible.
    MissingBaseline,
    /// The candidate aggregate outcome is an error, so the run measured no
    /// decision.
    CandidateError,
}

impl SelectionReason {
    /// Returns the contract word of this reason.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Disagreement => "disagreement",
            Self::SampledAgreement => "sampled_agreement",
            Self::MissingBaseline => "missing_baseline",
            Self::CandidateError => "candidate_error",
        }
    }

    /// Returns the inclusion rule sentence of this reason, as the export
    /// records it.
    pub const fn rule(self) -> &'static str {
        match self {
            Self::Disagreement => {
                "The stated baseline meaning differs from the candidate aggregate outcome. Such a report is always exported."
            }
            Self::SampledAgreement => {
                "The stated baseline meaning matches the candidate aggregate outcome, and one silent meaning matches one pass aggregate. Agreements are ranked by SHA-256 over the seed, the case identifier, and the input hash. The first agreements in rank order, up to the stated size, are exported."
            }
            Self::MissingBaseline => {
                "The report states no baseline. Such a report is always exported, because no comparison is possible."
            }
            Self::CandidateError => {
                "The candidate aggregate outcome is an error. Such a report is always exported, whatever its baseline states, because the run measured no decision."
            }
        }
    }
}

/// Parses the stated meanings of the host decision vocabulary.
///
/// The value holds one object that maps every baseline outcome word of the
/// host to one meaning word. One key holds 1 to 64 characters, the bound of
/// one baseline outcome, so every word one run can record finds its meaning
/// here. Two words may share one meaning.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `invalid_field_type` when the value
/// holds no object, when it holds no entry, when one key breaks its bound,
/// or when one value names no meaning.
pub fn parse_baseline_meanings(
    value: &serde_json::Value,
) -> Result<BTreeMap<String, BaselineMeaning>, ValidationError> {
    let root = crate::artifact::expect_object(value, "/baselineMeanings")?;
    if root.is_empty() {
        return Err(ValidationError::invalid_field_type(
            "/baselineMeanings",
            "The baseline meanings state at least one word of the host decision vocabulary.",
        ));
    }
    let mut meanings = BTreeMap::new();
    for (word, entry) in root {
        if word.is_empty() || word.chars().count() > 64 {
            return Err(ValidationError::invalid_field_type(
                format!("/baselineMeanings/{}", fragment_key(word)),
                "Each stated word must hold 1 to 64 characters, the bound of one baseline outcome.",
            ));
        }
        let meaning = match entry {
            serde_json::Value::String(text) => BaselineMeaning::from_word(text),
            _ => None,
        };
        let meaning = meaning.ok_or_else(|| {
            ValidationError::invalid_field_type(
                format!("/baselineMeanings/{word}"),
                "The meaning must be pass, fail, review, or silent.",
            )
        })?;
        meanings.insert(word.clone(), meaning);
    }
    Ok(meanings)
}

/// Returns one key as a JSON Pointer reference token, escaping `~` and `/`
/// and cutting one echo to 60 characters, the limit of every echoed name.
fn fragment_key(word: &str) -> String {
    let cut: String = word.chars().take(60).collect();
    let cut = if word.chars().count() > 60 {
        format!("{cut}...")
    } else {
        cut
    };
    cut.replace('~', "~0").replace('/', "~1")
}

/// The classification of one stored report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Classification {
    Agreement,
    Disagreement,
    MissingBaseline,
    CandidateError,
}

/// The recorded baseline of one review record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RecordedBaseline {
    /// The existing decision of the host, as the run recorded it.
    pub outcome: String,
    /// The revision of the existing decision path, as the run recorded it.
    pub revision: String,
    /// The meaning the host stated for the decision word.
    pub meaning: BaselineMeaning,
}

/// The candidate outcomes of one review record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CandidateOutcomes {
    /// The derived aggregate outcome of the run.
    pub aggregate: AggregateOutcome,
    /// The terminal execution status of the run.
    pub completion: CompletionStatus,
    /// The component outcome of every check, by check identifier.
    pub checks: BTreeMap<String, Outcome>,
}

/// One exported review record: one shadow case one human must review.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReviewRecord {
    /// Stable case identifier, as the run recorded it.
    pub case_id: String,
    /// The input-domain content hash of the case input.
    pub input_hash: String,
    /// The identifier of the run that measured the case.
    pub run_id: String,
    /// The host snapshot reference of the case input, when the run stated
    /// one. The record holds no raw case content.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<String>,
    /// The recorded baseline with its stated meaning. Absent when the run
    /// stated no baseline.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub baseline: Option<RecordedBaseline>,
    /// The candidate outcomes of the run.
    pub candidate: CandidateOutcomes,
    /// Why this record entered the export.
    pub selection_reason: SelectionReason,
}

/// The sampling provenance of one export.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SamplingProvenance {
    /// The seed the host stated.
    pub seed: String,
    /// The word that names the sampling algorithm.
    pub algorithm: &'static str,
    /// The agreements among the reports, selected or not.
    pub agreements: usize,
    /// The sample size the host stated.
    pub requested: usize,
    /// The agreements the sample selected.
    pub selected: usize,
    /// Plain statement of the sample.
    pub statement: String,
}

/// The counts of one export.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReviewSummary {
    /// The reports the export received.
    pub reports: usize,
    /// The reports classified as one agreement, selected or not.
    pub agreements: usize,
    /// The reports classified as one disagreement.
    pub disagreements: usize,
    /// The reports that state no baseline.
    pub missing_baselines: usize,
    /// The reports whose candidate aggregate outcome is an error.
    pub candidate_errors: usize,
    /// The records the export holds.
    pub selected: usize,
    /// The selected records by selection reason. Every reason key is
    /// present.
    pub selected_by_reason: BTreeMap<String, usize>,
    /// The selected records that state one baseline, by its meaning. Every
    /// meaning key is present.
    pub selected_by_baseline_meaning: BTreeMap<String, usize>,
}

/// The complete review export of one batch of stored shadow reports.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReviewExport {
    /// The portable contract schema version.
    pub schema_version: u32,
    /// The definition that produced the checks of every report.
    pub definition: crate::report::ArtifactReference,
    /// The profile that assessed every case.
    pub profile: crate::report::ProfileReference,
    /// The stated meanings of the host decision vocabulary.
    pub baseline_meanings: BTreeMap<String, BaselineMeaning>,
    /// The sampling provenance.
    pub sampling: SamplingProvenance,
    /// The inclusion rule sentence of every selection reason.
    pub inclusion_rules: BTreeMap<String, String>,
    /// Every selected record, in report order.
    pub records: Vec<ReviewRecord>,
    /// The counts of the export.
    pub summary: ReviewSummary,
    /// The standing limits of these records.
    pub limitations: Vec<String>,
}

/// Computes the sampling rank of one agreement.
///
/// The rank is the SHA-256 of the seed, the case identifier, and the input
/// hash, so the same reports, meanings, seed, and size always select the
/// same records whatever their order.
fn sampling_rank(seed: &str, case_id: &str, input_hash: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"measuretwice-review-sample\0");
    hasher.update(seed.as_bytes());
    hasher.update(b"\0");
    hasher.update(case_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(input_hash.as_bytes());
    hasher.finalize().into()
}

/// Validates the sampling options of one export.
fn validate_options(seed: &str, sample_size: usize) -> Result<(), ValidationError> {
    if seed.is_empty() || seed.chars().count() > MAX_SEED_CHARS {
        return Err(ValidationError::invalid_field_type(
            "/sample/seed",
            "The sampling seed must hold 1 to 128 characters.",
        ));
    }
    if sample_size > MAX_SAMPLED_AGREEMENTS {
        return Err(ValidationError::invalid_field_type(
            "/sample/agreements",
            format!(
                "The agreement sample size must be a whole number from 0 to {MAX_SAMPLED_AGREEMENTS}."
            ),
        ));
    }
    Ok(())
}

/// Classifies one stored report, or refuses one report the export cannot
/// cover.
fn classify(
    report: &RunReport,
    meanings: &BTreeMap<String, BaselineMeaning>,
) -> Result<Classification, ValidationError> {
    if report.aggregate() == AggregateOutcome::Error {
        // The run measured no decision, so its baseline decides nothing.
        // The meaning still resolves, so one unmapped word refuses below
        // whatever the aggregate states.
        if let Some(baseline) = report.baseline() {
            require_meaning(baseline, meanings)?;
        }
        return Ok(Classification::CandidateError);
    }
    let Some(baseline) = report.baseline() else {
        return Ok(Classification::MissingBaseline);
    };
    let meaning = require_meaning(baseline, meanings)?;
    Ok(if meaning.agrees_with(report.aggregate()) {
        Classification::Agreement
    } else {
        Classification::Disagreement
    })
}

/// Resolves the stated meaning of one recorded baseline.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `unknown_field` when the host stated
/// no meaning for the recorded decision word, because one silent drop would
/// hide one reviewable case.
fn require_meaning(
    baseline: &crate::report::Baseline,
    meanings: &BTreeMap<String, BaselineMeaning>,
) -> Result<BaselineMeaning, ValidationError> {
    meanings.get(&baseline.outcome).copied().ok_or_else(|| {
        ValidationError::new(
            ReasonCode::UnknownField,
            "/baseline/outcome",
            format!(
                "The baseline outcome {} names no meaning the host stated. State its meaning in the baseline meanings option.",
                fragment(&baseline.outcome)
            ),
        )
    })
}

/// Exports the stored shadow reports that need one human review.
///
/// The fixed rule order of the module documentation classifies every
/// report. Disagreements, reports without one baseline, and reports whose
/// candidate aggregate outcome is an error are always exported. Agreements
/// enter through the seeded sample alone. The records keep report order,
/// and every provenance field of [`ReviewExport`] states how the selection
/// came to be.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the seed or the sample size breaks
/// its bound, when the stated meanings hold no entry, when the reports hold
/// no entry (`insufficient_evidence` at `/reports`), when one report is no
/// shadow report, when two reports state different definitions or profiles,
/// when one case identifier repeats, or when one baseline word names no
/// stated meaning. Every report failure names its position under
/// `/reports/<index>`, counted from zero.
pub fn export_reviews(
    reports: &[RunReport],
    meanings: &BTreeMap<String, BaselineMeaning>,
    seed: &str,
    sample_size: usize,
) -> Result<ReviewExport, ValidationError> {
    validate_options(seed, sample_size)?;
    if meanings.is_empty() {
        return Err(ValidationError::invalid_field_type(
            "/baselineMeanings",
            "The baseline meanings state at least one word of the host decision vocabulary.",
        ));
    }
    if reports.is_empty() {
        return Err(ValidationError::new(
            ReasonCode::InsufficientEvidence,
            "/reports",
            "The export received no shadow report. Supply the stored reports of one shadow deployment, because one empty export reviews nothing.",
        ));
    }

    // Every report must come from one shadow deployment of one reviewer:
    // one definition and one profile produce the outcomes under review.
    let definition = reports[0].definition().clone();
    let profile = reports[0].profile().clone();
    let mut seen_cases: BTreeSet<&str> = BTreeSet::new();
    let mut classifications = Vec::with_capacity(reports.len());
    for (index, report) in reports.iter().enumerate() {
        let base = format!("/reports/{index}");
        if report.mode() != RunMode::Shadow {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/mode"),
                "A review export covers shadow reports. An enforcement report holds no baseline and no existing decision to review.",
            ));
        }
        if report.definition().content_hash != definition.content_hash
            || report.definition().name != definition.name
        {
            return Err(ValidationError::new(
                ReasonCode::DefinitionMismatch,
                format!("{base}/definition/content_hash"),
                "The report binds another definition. Export the reports of one definition, because one export states one provenance.",
            ));
        }
        if report.profile().content_hash != profile.content_hash
            || report.profile().id != profile.id
        {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/profile/content_hash"),
                "The report binds another profile. Export the reports of one profile, because the sample of one export covers one candidate.",
            ));
        }
        if !seen_cases.insert(report.case().id.as_str()) {
            return Err(ValidationError::new(
                ReasonCode::DuplicateId,
                format!("{base}/case/id"),
                format!(
                    "The case identifier {} repeats an earlier report. Supply one report per case.",
                    fragment(report.case().id.as_str())
                ),
            ));
        }
        classifications.push(classify(report, meanings).map_err(|error| error.at_report(index))?);
    }

    // The seeded sample: rank every agreement by its sampling rank, then
    // take the first ranks up to the stated size. The records keep report
    // order, so one reordered batch selects the same set.
    let agreements: Vec<usize> = classifications
        .iter()
        .enumerate()
        .filter(|(_, classification)| **classification == Classification::Agreement)
        .map(|(index, _)| index)
        .collect();
    let mut ranks: Vec<([u8; 32], &str)> = agreements
        .iter()
        .map(|&index| {
            let case = reports[index].case();
            (
                sampling_rank(seed, &case.id, &case.input_hash),
                case.id.as_str(),
            )
        })
        .collect();
    ranks.sort();
    let selected_count = ranks.len().min(sample_size);
    let sampled: BTreeSet<&str> = ranks[..selected_count]
        .iter()
        .map(|(_, case_id)| *case_id)
        .collect();

    let mut records = Vec::new();
    let mut selected_by_reason: BTreeMap<String, usize> = [
        SelectionReason::Disagreement,
        SelectionReason::SampledAgreement,
        SelectionReason::MissingBaseline,
        SelectionReason::CandidateError,
    ]
    .iter()
    .map(|reason| (reason.as_str().to_owned(), 0))
    .collect();
    let mut selected_by_baseline_meaning: BTreeMap<String, usize> = [
        BaselineMeaning::Pass,
        BaselineMeaning::Fail,
        BaselineMeaning::Review,
        BaselineMeaning::Silent,
    ]
    .iter()
    .map(|meaning| (meaning.as_str().to_owned(), 0))
    .collect();
    let mut summary = ReviewSummary {
        reports: reports.len(),
        agreements: agreements.len(),
        disagreements: 0,
        missing_baselines: 0,
        candidate_errors: 0,
        selected: 0,
        selected_by_reason: BTreeMap::new(),
        selected_by_baseline_meaning: BTreeMap::new(),
    };
    for (index, classification) in classifications.iter().enumerate() {
        let report = &reports[index];
        let reason = match classification {
            Classification::Disagreement => {
                summary.disagreements += 1;
                SelectionReason::Disagreement
            }
            Classification::MissingBaseline => {
                summary.missing_baselines += 1;
                SelectionReason::MissingBaseline
            }
            Classification::CandidateError => {
                summary.candidate_errors += 1;
                SelectionReason::CandidateError
            }
            Classification::Agreement => {
                if !sampled.contains(report.case().id.as_str()) {
                    continue;
                }
                SelectionReason::SampledAgreement
            }
        };
        let baseline = report.baseline().map(|baseline| RecordedBaseline {
            outcome: baseline.outcome.clone(),
            revision: baseline.revision.clone(),
            meaning: meanings[&baseline.outcome],
        });
        let checks = report
            .checks()
            .iter()
            .map(|record| (record.check.clone(), record.outcome))
            .collect();
        records.push(ReviewRecord {
            case_id: report.case().id.clone(),
            input_hash: report.case().input_hash.clone(),
            run_id: report.run_id().to_owned(),
            snapshot: report.case().snapshot().map(str::to_owned),
            baseline: baseline.clone(),
            candidate: CandidateOutcomes {
                aggregate: report.aggregate(),
                completion: report.completion().status,
                checks,
            },
            selection_reason: reason,
        });
        summary.selected += 1;
        *selected_by_reason
            .entry(reason.as_str().to_owned())
            .or_insert(0) += 1;
        if let Some(baseline) = &baseline {
            *selected_by_baseline_meaning
                .entry(baseline.meaning.as_str().to_owned())
                .or_insert(0) += 1;
        }
    }
    summary.selected_by_reason = selected_by_reason;
    summary.selected_by_baseline_meaning = selected_by_baseline_meaning;

    let inclusion_rules = [
        SelectionReason::Disagreement,
        SelectionReason::SampledAgreement,
        SelectionReason::MissingBaseline,
        SelectionReason::CandidateError,
    ]
    .iter()
    .map(|reason| (reason.as_str().to_owned(), reason.rule().to_owned()))
    .collect();
    Ok(ReviewExport {
        schema_version: crate::CONTRACT_SCHEMA_VERSION,
        definition,
        profile,
        baseline_meanings: meanings.clone(),
        sampling: SamplingProvenance {
            seed: seed.to_owned(),
            algorithm: SAMPLE_ALGORITHM,
            agreements: agreements.len(),
            requested: sample_size,
            selected: selected_count,
            statement: format!(
                "The sample is reproducible. The same reports, baseline meanings, seed, and size always select the same agreements. Agreements are ranked by {SAMPLE_ALGORITHM} over the seed, the case identifier, and the input hash, and the first {selected_count} of {} in rank order are selected. The records keep report order.",
                ranks.len()
            ),
        },
        inclusion_rules,
        records,
        summary,
        limitations: vec![
            NO_ACCURACY_CLAIM.to_owned(),
            "The sample of agreements is one reproducible selection, not one measurement of accuracy.".to_owned(),
            "A review of these records changes no qualification, no profile selection, and no application decision.".to_owned(),
        ],
    })
}

impl ValidationError {
    /// Moves one failure into one report position, prefixing
    /// `/reports/<index>` onto its field path.
    fn at_report(mut self, index: usize) -> Self {
        let prefix = format!("/reports/{index}");
        self.field_path = if self.field_path.is_empty() {
            prefix
        } else {
            format!("{prefix}{}", self.field_path)
        };
        self
    }

    /// Moves one failure into one label line, prefixing `/labels/<line>`
    /// onto its field path.
    fn at_label_line(mut self, line: usize) -> Self {
        let prefix = format!("/labels/{line}");
        self.field_path = if self.field_path.is_empty() {
            prefix
        } else {
            format!("{prefix}{}", self.field_path)
        };
        self
    }
}

/// One returned human label of one exported case.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReturnedLabel {
    /// Line of this label inside the returned file, counted from 1.
    pub line: usize,
    /// The exported case the label answers.
    pub case_id: String,
    /// The reference labels the reviewer stated.
    pub expected: ExpectedLabels,
    /// The provenance of the reference.
    pub label: LabelProvenance,
}

/// The provenance counts of one label return.
///
/// Only the reviewed counts are reviewed evidence. One model proposal that
/// no human reviewed stays one proposal, whatever the return states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ReviewLabelSummary {
    /// Number of returned lines.
    pub lines: usize,
    /// Human-written references with one recorded human review.
    pub human_reviewed: usize,
    /// Human-written references with no recorded review.
    pub human_unreviewed: usize,
    /// Model-proposed references with one recorded human review.
    pub model_reviewed: usize,
    /// Model-proposed references that no human reviewed.
    pub model_unreviewed: usize,
    /// References with one correction, so their history keeps the earlier
    /// provenance records.
    pub corrected: usize,
    /// References that state one review marker or carry one flagged
    /// conflict.
    pub review_required: usize,
}

/// The validation of one label return.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReviewLabelValidation {
    /// Every validated label, in return order.
    pub labels: Vec<ReturnedLabel>,
    /// The provenance counts of the return.
    pub summary: ReviewLabelSummary,
    /// Every flagged conflict, in return order.
    pub findings: Vec<LabelFinding>,
    /// The standing limits of this validation.
    pub limitations: Vec<String>,
}

/// Validates the labels one human returned for one review export.
///
/// The text holds one complete JSONL return: every nonempty line is one
/// `{ case_id, expected, label }` object. The case identifier must name one
/// record of the export. The expected-label object and the provenance
/// record follow the case-record contract, and every reference crosses the
/// meaning of its check exactly as the dataset loader checks it. One
/// reference whose acceptance meaning disagrees with its stated outcome
/// stays as written and appears under `findings`.
///
/// The validation reads no baseline, because baseline agreement is not
/// correctness: one label that contradicts the baseline outcome of its case
/// is one valid label.
///
/// # Errors
///
/// Returns a [`ValidationError`] with one `/labels/<line>` path when one
/// line holds no label, fails the strict JSON gate, breaks the label
/// contract, names no exported case, repeats one case, or states one
/// reference that breaks the meaning of its check. One return with no line
/// fails with `insufficient_evidence` at `/labels`.
pub fn validate_review_labels(
    definition: &ValidatedDefinition,
    exported: &BTreeSet<String>,
    labels_text: &str,
) -> Result<ReviewLabelValidation, ValidationError> {
    if labels_text.is_empty() {
        return Err(ValidationError::new(
            ReasonCode::InsufficientEvidence,
            "/labels",
            "The label return holds no line. Supply one label per exported case that was reviewed.",
        ));
    }
    let mut labels = Vec::new();
    let mut findings = Vec::new();
    let mut summary = ReviewLabelSummary {
        lines: 0,
        human_reviewed: 0,
        human_unreviewed: 0,
        model_reviewed: 0,
        model_unreviewed: 0,
        corrected: 0,
        review_required: 0,
    };
    let mut lines_of: BTreeMap<String, usize> = BTreeMap::new();
    for (index, raw) in label_lines(labels_text).enumerate() {
        let number = index + 1;
        let base = format!("/labels/{number}");
        if raw.trim().is_empty() {
            return Err(ValidationError::new(
                ReasonCode::InvalidJson,
                &base,
                "The line holds no returned label.",
            ));
        }
        let value = crate::json::parse_strict(raw).map_err(|error| error.at_label_line(number))?;
        let root = crate::artifact::expect_object(&value, &base)
            .map_err(|error| error.at_label_line(number))?;
        crate::artifact::reject_unknown_fields(root, &["case_id", "expected", "label"], &base)?;
        let case_id = match root.get("case_id") {
            Some(serde_json::Value::String(text)) if crate::case::is_case_id(text) => text.clone(),
            _ => {
                return Err(ValidationError::invalid_field_type(
                    format!("{base}/case_id"),
                    "The case identifier must start with a lowercase letter or a digit, then hold lowercase letters, digits, dots, underscores, or hyphens, 128 characters at most.",
                ));
            }
        };
        if !exported.contains(&case_id) {
            return Err(ValidationError::new(
                ReasonCode::UnknownField,
                format!("{base}/case_id"),
                format!(
                    "The returned label names no case of the review export: {}.",
                    fragment(&case_id)
                ),
            ));
        }
        if let Some(first) = lines_of.get(&case_id) {
            return Err(ValidationError::new(
                ReasonCode::DuplicateId,
                format!("{base}/case_id"),
                format!(
                    "The case identifier {} appears at lines {first} and {number}.",
                    fragment(&case_id)
                ),
            ));
        }
        lines_of.insert(case_id.clone(), number);
        let expected_value = root
            .get("expected")
            .ok_or_else(|| ValidationError::missing(format!("{base}/expected")))?;
        let expected = parse_expected_at(expected_value, &format!("{base}/expected"))?;
        if expected.checks.is_empty() && expected.outcome.is_none() {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/expected"),
                "One returned label states at least one reference or one expected outcome.",
            ));
        }
        let label_value = root
            .get("label")
            .ok_or_else(|| ValidationError::missing(format!("{base}/label")))?;
        let label = parse_label_at(label_value, &format!("{base}/label"))?;

        // Every reference crosses the meaning of its check through the same
        // rule the dataset loader runs, over one record that carries the
        // label alone: the case content stays with the host.
        let record = CaseRecord {
            line: number,
            group: case_id.clone(),
            tags: Vec::new(),
            input: serde_json::Map::new(),
            expected: Some(expected.clone()),
            label: label.clone(),
            id: case_id.clone(),
        };
        let record_findings = validate_record_labels(&record, definition)
            .map_err(|error| error.at_label_line(number))?;
        findings.extend(
            record_findings
                .into_iter()
                .map(|finding| LabelFinding::at_label_line(finding, number)),
        );

        summary.lines += 1;
        match (label.author_type, label.reviewed) {
            (LabelAuthor::Human, true) => summary.human_reviewed += 1,
            (LabelAuthor::Human, false) => summary.human_unreviewed += 1,
            (LabelAuthor::Model, true) => summary.model_reviewed += 1,
            (LabelAuthor::Model, false) => summary.model_unreviewed += 1,
        }
        if !label.history.is_empty() {
            summary.corrected += 1;
        }
        let ambiguous = expected.checks.values().any(|check| check.review);
        let flagged = findings
            .iter()
            .any(|finding| finding.case_id == case_id && finding.line == number);
        if ambiguous || flagged {
            summary.review_required += 1;
        }
        labels.push(ReturnedLabel {
            line: number,
            case_id,
            expected,
            label,
        });
    }
    Ok(ReviewLabelValidation {
        labels,
        summary,
        findings,
        limitations: vec![
            NO_BASELINE_AUTHORITY.to_owned(),
            ONLY_REVIEWED_LABELS.to_owned(),
        ],
    })
}

/// Splits one label return into its lines. A single trailing newline ends
/// the last line; every further empty line is one empty label line.
fn label_lines(labels_text: &str) -> impl Iterator<Item = &str> {
    let mut lines = labels_text.split('\n');
    if labels_text.ends_with('\n') {
        lines.next_back();
    }
    lines
}

impl LabelFinding {
    /// Moves one finding into one label line, prefixing `/labels/<line>`
    /// onto its field path.
    fn at_label_line(mut self, line: usize) -> Self {
        let prefix = format!("/labels/{line}");
        self.field_path = if self.field_path.is_empty() {
            prefix
        } else {
            format!("{prefix}{}", self.field_path)
        };
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::report::{
        AggregateOutcome, ArtifactReference, Baseline, CaseReference, CheckRecord, Completion,
        CompletionStatus, ProfileReference, RecordKind, ReportBuilder,
    };
    use serde_json::json;

    /// One 64-character hexadecimal hash from one repeated character.
    fn hash_hex(character: char) -> String {
        std::iter::repeat_n(character, 64).collect()
    }

    /// One component record for the builder.
    fn record(index: usize, outcome: Outcome) -> CheckRecord {
        let reason = match outcome {
            Outcome::Error => Some(crate::report::SanitizedReason {
                code: ReasonCode::EvaluatorError,
                message: "The adapter reported a network failure.".to_owned(),
                field_path: None,
            }),
            Outcome::Skipped => Some(crate::report::SanitizedReason {
                code: ReasonCode::QueueFull,
                message: "The pending-work limit stopped the check.".to_owned(),
                field_path: None,
            }),
            _ => None,
        };
        CheckRecord {
            check: format!("check-{index}"),
            kind: RecordKind::Question,
            outcome,
            assessment: None,
            applied_rule: None,
            applied_policy: None,
            evaluator: None,
            attempts: None,
            timing: None,
            usage: None,
            reason,
        }
    }

    /// One finished shadow report with the stated outcome and baseline.
    fn report(
        run_id: &str,
        case_id: &str,
        outcome: Outcome,
        baseline: Option<Baseline>,
        snapshot: Option<String>,
    ) -> RunReport {
        let mut builder = ReportBuilder::new(
            run_id,
            RunMode::Shadow,
            ArtifactReference {
                name: "message-review".to_owned(),
                content_hash: hash_hex('a'),
            },
            ProfileReference {
                id: "message-profile".to_owned(),
                content_hash: hash_hex('b'),
            },
            CaseReference {
                id: case_id.to_owned(),
                input_hash: hash_hex('c'),
                snapshot,
            },
            Completion {
                status: CompletionStatus::Completed,
                completed_at: Some("2026-09-24T10:00:02.500Z".to_owned()),
            },
        );
        builder = builder.check(record(0, outcome));
        if let Some(baseline) = baseline {
            builder = builder.baseline(baseline);
        }
        builder.finish().expect("the report finishes")
    }

    /// The meanings of one test host vocabulary.
    fn meanings() -> BTreeMap<String, BaselineMeaning> {
        parse_baseline_meanings(&json!({
            "send": "pass",
            "block": "fail",
            "flag": "review",
            "silent": "silent"
        }))
        .expect("the meanings parse")
    }

    #[test]
    fn the_meaning_words_round_trip_and_silent_reads_as_one_absent_decision() {
        for (word, meaning) in [
            ("pass", BaselineMeaning::Pass),
            ("fail", BaselineMeaning::Fail),
            ("review", BaselineMeaning::Review),
            ("silent", BaselineMeaning::Silent),
        ] {
            assert_eq!(BaselineMeaning::from_word(word), Some(meaning));
            assert_eq!(meaning.as_str(), word);
        }
        assert_eq!(BaselineMeaning::from_word("accept"), None);
        // One silent baseline matches one pass aggregate alone.
        assert!(BaselineMeaning::Silent.agrees_with(AggregateOutcome::Pass));
        assert!(!BaselineMeaning::Silent.agrees_with(AggregateOutcome::Fail));
        assert!(!BaselineMeaning::Silent.agrees_with(AggregateOutcome::Review));
        assert!(BaselineMeaning::Pass.agrees_with(AggregateOutcome::Pass));
        assert!(BaselineMeaning::Fail.agrees_with(AggregateOutcome::Fail));
        assert!(BaselineMeaning::Review.agrees_with(AggregateOutcome::Review));
        assert!(!BaselineMeaning::Pass.agrees_with(AggregateOutcome::Fail));
    }

    #[test]
    fn broken_meaning_maps_report_their_fields() {
        let empty = parse_baseline_meanings(&json!({}));
        assert_eq!(empty.unwrap_err().code, ReasonCode::InvalidFieldType);
        let not_object = parse_baseline_meanings(&json!(["send"]));
        assert_eq!(not_object.unwrap_err().code, ReasonCode::InvalidFieldType);
        let unknown = parse_baseline_meanings(&json!({"send": "accept"}));
        let error = unknown.unwrap_err();
        assert_eq!(error.code, ReasonCode::InvalidFieldType);
        assert_eq!(error.field_path, "/baselineMeanings/send");
        let overlong = parse_baseline_meanings(&json!({"s".repeat(65): "pass"}));
        let error = overlong.unwrap_err();
        assert_eq!(error.code, ReasonCode::InvalidFieldType);
        assert!(error.field_path.starts_with("/baselineMeanings/"));
        let wrong_type = parse_baseline_meanings(&json!({"send": 1}));
        assert_eq!(wrong_type.unwrap_err().code, ReasonCode::InvalidFieldType);
    }

    #[test]
    fn disagreements_missing_baselines_and_errors_are_always_exported() {
        let reports = vec![
            report(
                "run-1",
                "case-disagree",
                Outcome::Fail,
                Some(Baseline {
                    outcome: "send".to_owned(),
                    revision: "policy-2026-03".to_owned(),
                }),
                None,
            ),
            report("run-2", "case-missing", Outcome::Pass, None, None),
            report(
                "run-3",
                "case-error",
                Outcome::Error,
                Some(Baseline {
                    outcome: "silent".to_owned(),
                    revision: "policy-2026-03".to_owned(),
                }),
                None,
            ),
        ];
        let export = export_reviews(&reports, &meanings(), "seed-1", 0).expect("the export builds");
        assert_eq!(export.schema_version, 1);
        assert_eq!(export.records.len(), 3);
        assert_eq!(export.summary.reports, 3);
        assert_eq!(export.summary.disagreements, 1);
        assert_eq!(export.summary.missing_baselines, 1);
        assert_eq!(export.summary.candidate_errors, 1);
        assert_eq!(export.summary.agreements, 0);
        // Baseline passes and silent baseline cases reach the reviewer, not
        // only suspicious cases.
        assert_eq!(export.summary.selected_by_reason["disagreement"], 1);
        assert_eq!(export.summary.selected_by_reason["missing_baseline"], 1);
        assert_eq!(export.summary.selected_by_reason["candidate_error"], 1);
        assert_eq!(export.summary.selected_by_baseline_meaning["pass"], 1);
        assert_eq!(export.summary.selected_by_baseline_meaning["silent"], 1);
        let disagree = &export.records[0];
        assert_eq!(disagree.case_id, "case-disagree");
        assert_eq!(disagree.selection_reason, SelectionReason::Disagreement);
        assert_eq!(
            disagree.baseline.as_ref().expect("one baseline").outcome,
            "send"
        );
        assert_eq!(
            disagree.baseline.as_ref().expect("one baseline").meaning,
            BaselineMeaning::Pass
        );
        assert_eq!(disagree.candidate.aggregate, AggregateOutcome::Fail);
        assert_eq!(disagree.candidate.completion, CompletionStatus::Completed);
        assert_eq!(disagree.candidate.checks["check-0"], Outcome::Fail);
        let missing = &export.records[1];
        assert_eq!(missing.selection_reason, SelectionReason::MissingBaseline);
        assert!(missing.baseline.is_none());
        let errored = &export.records[2];
        assert_eq!(errored.selection_reason, SelectionReason::CandidateError);
        assert_eq!(errored.candidate.aggregate, AggregateOutcome::Error);
        // The provenance retains the rules, the meanings, and the seed.
        assert_eq!(export.inclusion_rules.len(), 4);
        assert_eq!(export.baseline_meanings.len(), 4);
        assert_eq!(export.sampling.seed, "seed-1");
        assert_eq!(export.sampling.algorithm, SAMPLE_ALGORITHM);
    }

    #[test]
    fn one_silent_baseline_against_one_fail_aggregate_is_one_disagreement() {
        let reports = vec![report(
            "run-1",
            "case-1",
            Outcome::Fail,
            Some(Baseline {
                outcome: "silent".to_owned(),
                revision: "heuristic-v4".to_owned(),
            }),
            None,
        )];
        let export = export_reviews(&reports, &meanings(), "seed-1", 0).expect("the export builds");
        assert_eq!(export.summary.disagreements, 1);
        assert_eq!(
            export.records[0].selection_reason,
            SelectionReason::Disagreement
        );
        // Baseline silence is no evidence that the candidate is wrong, and
        // the record states both observations without merging them.
        assert_eq!(
            export.records[0]
                .baseline
                .as_ref()
                .expect("one baseline")
                .meaning,
            BaselineMeaning::Silent
        );
        let record = serde_json::to_value(&export.records[0]).expect("the record serializes");
        let text = record.to_string();
        // The selection word `disagreement` carries the substring
        // `agreement`, so the scan covers the words that would merge the
        // two outcomes, not the reason vocabulary itself.
        for forbidden in ["accuracy", "correct", "authorized", "approved"] {
            assert!(!text.contains(forbidden), "the record states {forbidden}");
        }
        assert!(
            !text.contains("\"agrees\""),
            "the record states one agreement field"
        );
    }

    #[test]
    fn agreements_enter_through_one_reproducible_sample_alone() {
        let mut reports = Vec::new();
        for index in 0..6 {
            reports.push(report(
                &format!("run-{index}"),
                &format!("case-{index}"),
                Outcome::Pass,
                Some(Baseline {
                    outcome: "silent".to_owned(),
                    revision: "heuristic-v4".to_owned(),
                }),
                None,
            ));
        }
        let first = export_reviews(&reports, &meanings(), "seed-1", 3).expect("the export builds");
        assert_eq!(first.summary.agreements, 6);
        assert_eq!(first.sampling.requested, 3);
        assert_eq!(first.sampling.selected, 3);
        assert_eq!(first.records.len(), 3);
        assert!(first
            .records
            .iter()
            .all(|record| record.selection_reason == SelectionReason::SampledAgreement));
        assert_eq!(first.summary.selected_by_baseline_meaning["silent"], 3);

        // The same inputs select the same cases, and one reordered batch
        // selects the same set.
        let repeated =
            export_reviews(&reports, &meanings(), "seed-1", 3).expect("the export builds");
        assert_eq!(repeated.records, first.records);
        let mut reordered: Vec<RunReport> = reports.clone();
        reordered.reverse();
        let shuffled =
            export_reviews(&reordered, &meanings(), "seed-1", 3).expect("the export builds");
        let ids_of = |export: &ReviewExport| {
            let mut ids: Vec<String> = export
                .records
                .iter()
                .map(|record| record.case_id.clone())
                .collect();
            ids.sort();
            ids
        };
        assert_eq!(ids_of(&shuffled), ids_of(&first));

        // Another seed selects another set, and one larger size selects one
        // superset, because the rank order is fixed.
        let other = export_reviews(&reports, &meanings(), "seed-2", 3).expect("the export builds");
        assert_ne!(ids_of(&other), ids_of(&first));
        let larger = export_reviews(&reports, &meanings(), "seed-1", 6).expect("the export builds");
        assert!(ids_of(&larger).len() > ids_of(&first).len());
        // The rank order is fixed, so one larger size selects one superset.
        assert!(ids_of(&first).iter().all(|id| ids_of(&larger).contains(id)));

        // One size above the agreement count selects every agreement.
        let all = export_reviews(&reports, &meanings(), "seed-1", 100).expect("the export builds");
        assert_eq!(all.records.len(), 6);
        assert_eq!(all.sampling.selected, 6);

        // One zero size exports no agreement.
        let none = export_reviews(&reports, &meanings(), "seed-1", 0).expect("the export builds");
        assert_eq!(none.records.len(), 0);
        assert_eq!(none.summary.selected, 0);
        assert_eq!(none.summary.agreements, 6);
    }

    #[test]
    fn one_host_snapshot_reference_travels_and_no_case_content_crosses() {
        let reports = vec![report(
            "run-1",
            "case-1",
            Outcome::Fail,
            Some(Baseline {
                outcome: "send".to_owned(),
                revision: "heuristic-v4".to_owned(),
            }),
            Some("snapshots/case-1".to_owned()),
        )];
        let export = export_reviews(&reports, &meanings(), "seed-1", 0).expect("the export builds");
        assert_eq!(export.records.len(), 1);
        assert_eq!(
            export.records[0].snapshot.as_deref(),
            Some("snapshots/case-1")
        );
        // The record holds no case input: the identifiers, the hashes, and
        // the host reference alone cross.
        let serialized = serde_json::to_string(&export.records[0]).expect("the record serializes");
        assert!(
            !serialized.contains("input\""),
            "the record states one input object"
        );
    }

    #[test]
    fn broken_batches_refuse_with_their_report_position() {
        let baseline = Baseline {
            outcome: "send".to_owned(),
            revision: "policy-2026-03".to_owned(),
        };
        let rows: Vec<(Vec<RunReport>, &str, String)> = vec![
            // No report reviews nothing.
            (Vec::new(), "insufficient_evidence", "/reports".to_owned()),
            // One unmapped baseline word names no stated meaning.
            (
                vec![report(
                    "run-1",
                    "case-1",
                    Outcome::Pass,
                    Some(Baseline {
                        outcome: "defer".to_owned(),
                        revision: "policy-2026-03".to_owned(),
                    }),
                    None,
                )],
                "unknown_field",
                "/reports/0/baseline/outcome".to_owned(),
            ),
            // One repeated case identifier is one ambiguous review target.
            (
                vec![
                    report(
                        "run-1",
                        "case-1",
                        Outcome::Pass,
                        Some(baseline.clone()),
                        None,
                    ),
                    report(
                        "run-2",
                        "case-1",
                        Outcome::Fail,
                        Some(baseline.clone()),
                        None,
                    ),
                ],
                "duplicate_id",
                "/reports/1/case/id".to_owned(),
            ),
        ];
        for (reports, code, path) in rows {
            let error = export_reviews(&reports, &meanings(), "seed-1", 1).unwrap_err();
            assert_eq!(error.code.as_str(), code, "{error}");
            assert_eq!(error.field_path, path, "{error}");
        }

        // One enforcement report holds no baseline and no existing decision.
        let enforced = {
            let mut builder = ReportBuilder::new(
                "run-1",
                RunMode::Enforcement,
                ArtifactReference {
                    name: "message-review".to_owned(),
                    content_hash: hash_hex('a'),
                },
                ProfileReference {
                    id: "message-profile".to_owned(),
                    content_hash: hash_hex('b'),
                },
                CaseReference {
                    id: "case-1".to_owned(),
                    input_hash: hash_hex('c'),
                    snapshot: None,
                },
                Completion {
                    status: CompletionStatus::Completed,
                    completed_at: None,
                },
            );
            builder = builder.check(record(0, Outcome::Pass));
            builder.finish().expect("the report finishes")
        };
        let error = export_reviews(&[enforced], &meanings(), "seed-1", 1).unwrap_err();
        assert_eq!(error.code, ReasonCode::InvalidFieldType);
        assert_eq!(error.field_path, "/reports/0/mode");

        // One foreign definition or profile breaks the provenance of the
        // batch: the export states one definition and one profile.
        let first = report(
            "run-1",
            "case-1",
            Outcome::Pass,
            Some(baseline.clone()),
            None,
        );
        let foreign = rebuild_with_definition(
            report(
                "run-2",
                "case-2",
                Outcome::Pass,
                Some(baseline.clone()),
                None,
            ),
            ArtifactReference {
                name: "message-review".to_owned(),
                content_hash: hash_hex('d'),
            },
        );
        let error =
            export_reviews(&[first.clone(), foreign], &meanings(), "seed-1", 1).unwrap_err();
        assert_eq!(error.code, ReasonCode::DefinitionMismatch);
        assert_eq!(error.field_path, "/reports/1/definition/content_hash");
        let rebind = rebuild_with_profile(
            report(
                "run-2",
                "case-2",
                Outcome::Pass,
                Some(baseline.clone()),
                None,
            ),
            ProfileReference {
                id: "message-profile".to_owned(),
                content_hash: hash_hex('e'),
            },
        );
        let error = export_reviews(&[first, rebind], &meanings(), "seed-1", 1).unwrap_err();
        assert_eq!(error.code, ReasonCode::InvalidFieldType);
        assert_eq!(error.field_path, "/reports/1/profile/content_hash");

        // Broken options refuse before any report work.
        let reports = vec![report(
            "run-1",
            "case-1",
            Outcome::Pass,
            Some(baseline),
            None,
        )];
        let empty_seed = export_reviews(&reports, &meanings(), "", 1).unwrap_err();
        assert_eq!(empty_seed.field_path, "/sample/seed");
        let long_seed = export_reviews(&reports, &meanings(), &"s".repeat(129), 1).unwrap_err();
        assert_eq!(long_seed.field_path, "/sample/seed");
        let oversized = export_reviews(&reports, &meanings(), "seed-1", MAX_SAMPLED_AGREEMENTS + 1)
            .unwrap_err();
        assert_eq!(oversized.field_path, "/sample/agreements");
        let no_meanings = export_reviews(&reports, &BTreeMap::new(), "seed-1", 1).unwrap_err();
        assert_eq!(no_meanings.field_path, "/baselineMeanings");
    }

    /// Rebuilds one report with another definition reference.
    fn rebuild_with_definition(report: RunReport, definition: ArtifactReference) -> RunReport {
        let mut stored = serde_json::to_value(&report).expect("the report serializes");
        stored["definition"] = json!(definition);
        crate::report::parse_run_report(&stored).expect("the report parses")
    }

    /// Rebuilds one report with another profile reference.
    fn rebuild_with_profile(report: RunReport, profile: ProfileReference) -> RunReport {
        let mut stored = serde_json::to_value(&report).expect("the report serializes");
        stored["profile"] = json!(profile);
        crate::report::parse_run_report(&stored).expect("the report parses")
    }

    /// One definition with one categorical question for the label checks.
    fn question_definition() -> ValidatedDefinition {
        let artifact = json!({
            "schema_version": 1,
            "name": "message-review",
            "inputs": {
                "type": "object",
                "properties": {"text": {"type": "string", "minLength": 1}},
                "required": ["text"],
                "additionalProperties": false
            },
            "checks": [{
                "id": "message-supported",
                "name": "Our message describes the evidence",
                "using": ["text"],
                "question": "Does every claim follow from the evidence?",
                "answers": {
                    "supported": "Every claim follows.",
                    "contradicted": "One claim conflicts.",
                    "incomplete": "Support is missing."
                },
                "accept": "supported",
                "review": "incomplete"
            }]
        });
        crate::definition::validate_definition_str(&artifact.to_string())
            .expect("the definition validates")
    }

    /// The exported case identifiers of one small export.
    fn exported_cases() -> BTreeSet<String> {
        BTreeSet::from(["case-1".to_owned(), "case-2".to_owned()])
    }

    #[test]
    fn returned_labels_validate_against_the_meaning_of_their_checks() {
        let definition = question_definition();
        let labels_text = concat!(
            "{\"case_id\":\"case-1\",\"expected\":{\"checks\":{\"message-supported\":{\"answer\":\"supported\"}}},",
            "\"label\":{\"author_type\":\"human\",\"reviewed\":true,\"reviewer\":\"dana\",\"origin\":\"collected\",\"reason\":\"The message follows.\"}}\n",
            "{\"case_id\":\"case-2\",\"expected\":{\"outcome\":\"review\"},",
            "\"label\":{\"author_type\":\"model\",\"reviewed\":false,\"origin\":\"collected\"}}\n"
        );
        let validation = validate_review_labels(&definition, &exported_cases(), labels_text)
            .expect("the labels validate");
        assert_eq!(validation.summary.lines, 2);
        assert_eq!(validation.summary.human_reviewed, 1);
        assert_eq!(validation.summary.model_unreviewed, 1);
        assert_eq!(validation.findings.len(), 0);
        assert_eq!(validation.labels[0].case_id, "case-1");
        assert_eq!(
            validation.labels[0].expected.checks["message-supported"]
                .answer
                .as_deref(),
            Some("supported")
        );
        assert_eq!(validation.labels[1].line, 2);
        // The standing limits keep the two rules of the validation visible.
        assert!(validation
            .limitations
            .iter()
            .any(|text| text == NO_BASELINE_AUTHORITY));
        assert!(validation
            .limitations
            .iter()
            .any(|text| text == ONLY_REVIEWED_LABELS));
    }

    #[test]
    fn one_label_that_contradicts_the_baseline_outcome_is_valid() {
        // The baseline of case-1 recorded `send`, which the export mapped to
        // pass. The human labels the reference answer `contradicted`, which
        // means fail. The validation reads no baseline, so the label is one
        // valid label and the result states no conflict with the baseline.
        let definition = question_definition();
        let labels_text = concat!(
            "{\"case_id\":\"case-1\",\"expected\":{\"checks\":{\"message-supported\":{\"answer\":\"contradicted\"}}},",
            "\"label\":{\"author_type\":\"human\",\"reviewed\":true,\"reviewer\":\"dana\"}}\n"
        );
        let validation = validate_review_labels(&definition, &exported_cases(), labels_text)
            .expect("the labels validate");
        assert_eq!(validation.summary.lines, 1);
        assert_eq!(validation.summary.review_required, 0);
        // No field of the result compares one label with one baseline and
        // no field states one accuracy. The standing limitation names the
        // baseline to state its lack of authority, so the keys decide.
        let value = serde_json::to_value(&validation).expect("serializes");
        fn has_key(value: &serde_json::Value, key: &str) -> bool {
            match value {
                serde_json::Value::Object(map) => {
                    map.contains_key(key) || map.values().any(|entry| has_key(entry, key))
                }
                serde_json::Value::Array(items) => items.iter().any(|entry| has_key(entry, key)),
                _ => false,
            }
        }
        for forbidden in ["baseline", "agreement", "agrees", "accuracy", "correct"] {
            assert!(
                !has_key(&value, forbidden),
                "the validation states {forbidden}"
            );
        }
    }

    #[test]
    fn one_conflicting_reference_stays_as_written_and_is_flagged() {
        let definition = question_definition();
        let labels_text = concat!(
            "{\"case_id\":\"case-1\",\"expected\":{\"checks\":{\"message-supported\":{\"answer\":\"supported\",\"outcome\":\"fail\"}}},",
            "\"label\":{\"author_type\":\"human\",\"reviewed\":true,\"reviewer\":\"dana\"}}\n"
        );
        let validation = validate_review_labels(&definition, &exported_cases(), labels_text)
            .expect("the labels validate");
        assert_eq!(validation.findings.len(), 1);
        let finding = &validation.findings[0];
        assert_eq!(finding.line, 1);
        assert_eq!(finding.case_id, "case-1");
        assert_eq!(finding.kind.as_str(), "check_outcome_conflict");
        assert_eq!(
            finding.field_path,
            "/labels/1/expected/checks/message-supported/outcome"
        );
        assert_eq!(validation.summary.review_required, 1);
        // The reference stays as written.
        assert_eq!(
            validation.labels[0].expected.checks["message-supported"]
                .outcome
                .as_deref(),
            Some("fail")
        );
    }

    #[test]
    fn broken_label_returns_report_their_line_and_field() {
        let definition = question_definition();
        let rows: Vec<(&str, &str, String)> = vec![
            (
                "",
                "insufficient_evidence",
                "/labels".to_owned(),
            ),
            (
                "\n",
                "invalid_json",
                "/labels/1".to_owned(),
            ),
            (
                "{\"case_id\":\"case-1\"}\n",
                "missing_field",
                "/labels/1/expected".to_owned(),
            ),
            (
                "{\"case_id\":\"case-1\",\"expected\":{\"checks\":{\"message-supported\":{\"answer\":\"supported\"}}},\"label\":{\"author_type\":\"human\",\"reviewed\":false},\"note\":\"x\"}\n",
                "unknown_field",
                "/labels/1/note".to_owned(),
            ),
            (
                "{\"case_id\":\"case-9\",\"expected\":{\"outcome\":\"pass\"},\"label\":{\"author_type\":\"human\",\"reviewed\":false}}\n",
                "unknown_field",
                "/labels/1/case_id".to_owned(),
            ),
            (
                "{\"case_id\":\"case-1\",\"expected\":{\"outcome\":\"pass\"},\"label\":{\"author_type\":\"human\",\"reviewed\":false}}\n{\"case_id\":\"case-1\",\"expected\":{\"outcome\":\"fail\"},\"label\":{\"author_type\":\"human\",\"reviewed\":false}}\n",
                "duplicate_id",
                "/labels/2/case_id".to_owned(),
            ),
            (
                "{\"case_id\":\"case-1\",\"expected\":{\"checks\":{\"unknown-check\":{\"outcome\":\"pass\"}}},\"label\":{\"author_type\":\"human\",\"reviewed\":false}}\n",
                "unknown_field",
                "/labels/1/expected/checks/unknown-check".to_owned(),
            ),
            (
                "{\"case_id\":\"case-1\",\"expected\":{\"checks\":{\"message-supported\":{\"answer\":\"unknown\"}}},\"label\":{\"author_type\":\"human\",\"reviewed\":false}}\n",
                "unknown_label",
                "/labels/1/expected/checks/message-supported/answer".to_owned(),
            ),
            (
                "{\"case_id\":\"case-1\",\"expected\":{},\"label\":{\"author_type\":\"human\",\"reviewed\":false}}\n",
                "invalid_field_type",
                "/labels/1/expected".to_owned(),
            ),
            (
                "{\"case_id\":\"case-1\",\"expected\":{\"outcome\":\"pass\"},\"label\":{\"author_type\":\"human\",\"reviewed\":true}}\n",
                "missing_field",
                "/labels/1/label/reviewer".to_owned(),
            ),
        ];
        for (labels_text, code, path) in rows {
            let error =
                validate_review_labels(&definition, &exported_cases(), labels_text).unwrap_err();
            assert_eq!(error.code.as_str(), code, "{error} for {labels_text}");
            assert_eq!(error.field_path, path, "{error} for {labels_text}");
        }
    }
}
