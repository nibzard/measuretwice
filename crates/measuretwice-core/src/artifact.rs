// SPDX-License-Identifier: Apache-2.0
//! Shared envelope rules for every portable artifact.
//!
//! Every artifact states `schema_version`. A reader accepts only a version
//! it supports. It rejects an unknown or higher version with
//! `unsupported_schema_version`, and it never coerces. The rule comes from
//! the contracts README and applies to all nine artifact schemas.

use crate::error::{ReasonCode, ValidationError};
use serde_json::{Map, Value};

/// Reads and checks the `schema_version` field of one artifact object.
///
/// # Errors
///
/// Returns `missing_field` when the field is absent,
/// `invalid_field_type` when it is not an integer, and
/// `unsupported_schema_version` when it differs from the version this core
/// implements.
pub fn schema_version(object: &Map<String, Value>) -> Result<u32, ValidationError> {
    let Some(field) = object.get("schema_version") else {
        return Err(ValidationError::missing("/schema_version"));
    };
    let Value::Number(number) = field else {
        return Err(ValidationError::invalid_field_type(
            "/schema_version",
            "The schema_version field must be an integer.",
        ));
    };
    // A number with a fraction, such as 1.0, is not the integer form. The
    // gate does not coerce it. A negative integer states a version number
    // that no release published.
    let version: i128 = if let Some(unsigned) = number.as_u64() {
        i128::from(unsigned)
    } else if let Some(signed) = number.as_i64() {
        i128::from(signed)
    } else {
        return Err(ValidationError::invalid_field_type(
            "/schema_version",
            "The schema_version field must be an integer.",
        ));
    };
    let supported = i128::from(crate::CONTRACT_SCHEMA_VERSION);
    if version == supported {
        Ok(crate::CONTRACT_SCHEMA_VERSION)
    } else {
        Err(ValidationError::new(
            ReasonCode::UnsupportedSchemaVersion,
            "/schema_version",
            format!(
                "The artifact states schema_version {version}. This core supports version {supported}."
            ),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().expect("an object").clone()
    }

    #[test]
    fn a_stated_supported_version_passes() {
        assert_eq!(schema_version(&object(json!({"schema_version": 1}))), Ok(1));
    }

    #[test]
    fn an_absent_version_is_a_missing_field() {
        let error = schema_version(&object(json!({}))).expect_err("absent");
        assert_eq!(error.code, ReasonCode::MissingField);
        assert_eq!(error.field_path, "/schema_version");
    }

    #[test]
    fn a_non_integer_version_is_an_invalid_field_type() {
        for value in [json!("1"), json!(1.0), json!(true), json!(null), json!([1])] {
            let error =
                schema_version(&object(json!({"schema_version": value}))).expect_err("not integer");
            assert_eq!(error.code, ReasonCode::InvalidFieldType, "{value}: {error}");
            assert_eq!(error.field_path, "/schema_version");
        }
    }

    #[test]
    fn an_unsupported_version_is_rejected() {
        for value in [0, 2, 10, -1] {
            let error =
                schema_version(&object(json!({"schema_version": value}))).expect_err("unsupported");
            assert_eq!(
                error.code,
                ReasonCode::UnsupportedSchemaVersion,
                "{value}: {error}"
            );
            assert_eq!(error.field_path, "/schema_version");
        }
    }
}
