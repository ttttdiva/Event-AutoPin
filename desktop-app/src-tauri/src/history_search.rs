use chrono::{Local, NaiveDate};
use serde::Serialize;
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use unicode_normalization::UnicodeNormalization;

const DEFAULT_RESULT_LIMIT: usize = 100;
const MAX_RESULT_LIMIT: usize = 500;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySearchResult {
    event_name: String,
    event_date: String,
    event_dir: String,
    circle_name: String,
    penname: String,
    space: String,
    hall: String,
    matched_by: String,
    matched_text: String,
    matched_titles: Vec<String>,
    score: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySearchResponse {
    status: &'static str,
    query: String,
    normalized_query: String,
    scanned_events: usize,
    scanned_circles: usize,
    skipped_events: usize,
    excluded_upcoming_events: usize,
    total_matches: usize,
    truncated: bool,
    results: Vec<HistorySearchResult>,
}

fn normalize_search_text(value: &str) -> String {
    value
        .nfkc()
        .flat_map(char::to_lowercase)
        .filter_map(|ch| {
            let normalized = match ch {
                '\u{3041}'..='\u{3096}' => char::from_u32(ch as u32 + 0x60).unwrap_or(ch),
                _ => ch,
            };
            normalized.is_alphanumeric().then_some(normalized)
        })
        .collect()
}

fn levenshtein_distance(left: &[char], right: &[char]) -> usize {
    if left.is_empty() {
        return right.len();
    }
    if right.is_empty() {
        return left.len();
    }

    let mut previous: Vec<usize> = (0..=right.len()).collect();
    let mut current = vec![0; right.len() + 1];
    for (left_index, left_char) in left.iter().enumerate() {
        current[0] = left_index + 1;
        for (right_index, right_char) in right.iter().enumerate() {
            let substitution = previous[right_index] + usize::from(left_char != right_char);
            let insertion = current[right_index] + 1;
            let deletion = previous[right_index + 1] + 1;
            current[right_index + 1] = substitution.min(insertion).min(deletion);
        }
        std::mem::swap(&mut previous, &mut current);
    }
    previous[right.len()]
}

fn is_subsequence(needle: &[char], haystack: &[char]) -> bool {
    if needle.is_empty() {
        return true;
    }
    let mut index = 0;
    for ch in haystack {
        if *ch == needle[index] {
            index += 1;
            if index == needle.len() {
                return true;
            }
        }
    }
    false
}

fn best_window_similarity(query: &[char], candidate: &[char]) -> f64 {
    if query.is_empty() || candidate.is_empty() {
        return 0.0;
    }
    if candidate.len() <= query.len() {
        let max_len = query.len().max(candidate.len());
        return 1.0 - levenshtein_distance(query, candidate) as f64 / max_len as f64;
    }

    let length_slack = match query.len() {
        0..=4 => 1,
        5..=8 => 2,
        _ => 3,
    };
    let min_window = query.len().saturating_sub(length_slack).max(1);
    let max_window = (query.len() + length_slack).min(candidate.len());
    let mut best: f64 = 0.0;
    for window_len in min_window..=max_window {
        for start in 0..=candidate.len() - window_len {
            let window = &candidate[start..start + window_len];
            let max_len = query.len().max(window.len());
            let similarity = 1.0 - levenshtein_distance(query, window) as f64 / max_len as f64;
            best = best.max(similarity);
        }
    }
    best
}

fn fuzzy_score(normalized_query: &str, candidate: &str) -> Option<f64> {
    let normalized_candidate = normalize_search_text(candidate);
    if normalized_candidate.is_empty() {
        return None;
    }
    if normalized_candidate == normalized_query {
        return Some(100.0);
    }
    if normalized_candidate.contains(normalized_query) {
        let coverage = normalized_query.chars().count() as f64
            / normalized_candidate.chars().count().max(1) as f64;
        return Some(88.0 + coverage * 10.0);
    }
    if normalized_query.contains(&normalized_candidate) && normalized_candidate.chars().count() >= 3
    {
        let coverage = normalized_candidate.chars().count() as f64
            / normalized_query.chars().count().max(1) as f64;
        if coverage >= 0.70 {
            return Some(80.0 + coverage * 8.0);
        }
    }

    let query_chars: Vec<char> = normalized_query.chars().collect();
    let candidate_chars: Vec<char> = normalized_candidate.chars().collect();
    let similarity = best_window_similarity(&query_chars, &candidate_chars);
    let min_similarity = match query_chars.len() {
        0..=2 => 1.0,
        3..=4 => 0.70,
        5..=7 => 0.62,
        _ => 0.56,
    };
    if similarity >= min_similarity {
        return Some(55.0 + similarity * 30.0);
    }

    if query_chars.len() >= 4 && is_subsequence(&query_chars, &candidate_chars) {
        let coverage = query_chars.len() as f64 / candidate_chars.len().max(1) as f64;
        if coverage >= 0.55 {
            return Some(52.0 + coverage * 20.0);
        }
    }
    None
}

fn value_text(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn push_unique(values: &mut Vec<String>, seen: &mut HashSet<String>, value: String) {
    if value.is_empty() {
        return;
    }
    let key = normalize_search_text(&value);
    if !key.is_empty() && seen.insert(key) {
        values.push(value);
    }
}

fn collect_item_titles(circle: &Value) -> Vec<String> {
    let mut titles = Vec::new();
    let mut seen = HashSet::new();

    for key in ["items", "books", "item_titles", "book_titles"] {
        let Some(items) = circle.get(key).and_then(Value::as_array) else {
            continue;
        };
        for item in items {
            if let Some(title) = item.as_str() {
                push_unique(&mut titles, &mut seen, title.trim().to_string());
                continue;
            }
            for title_key in ["name", "title", "book_title", "item_name"] {
                let title = value_text(item.get(title_key));
                if !title.is_empty() {
                    push_unique(&mut titles, &mut seen, title);
                    break;
                }
            }
        }
    }
    for key in ["title", "book_title", "new_book_title"] {
        push_unique(&mut titles, &mut seen, value_text(circle.get(key)));
    }
    titles
}

fn best_text_match<'a>(
    normalized_query: &str,
    candidates: impl IntoIterator<Item = &'a str>,
) -> Option<(f64, String)> {
    candidates
        .into_iter()
        .filter_map(|candidate| {
            fuzzy_score(normalized_query, candidate).map(|score| (score, candidate.to_string()))
        })
        .max_by(|left, right| left.0.partial_cmp(&right.0).unwrap_or(Ordering::Equal))
}

fn search_events_dir(
    events_dir: &Path,
    query: &str,
    limit: usize,
    today: NaiveDate,
) -> Result<HistorySearchResponse, String> {
    let normalized_query = normalize_search_text(query);
    if normalized_query.chars().count() < 2 {
        return Err("検索語は記号・空白を除いて2文字以上入力してください".to_string());
    }

    let mut scanned_events = 0;
    let mut scanned_circles = 0;
    let mut skipped_events = 0;
    let mut excluded_upcoming_events = 0;
    let mut results = Vec::new();

    if !events_dir.is_dir() {
        return Err(format!(
            "eventsフォルダが見つかりません。設定のプロジェクトルートを確認してください: {}",
            events_dir.display()
        ));
    }

    let entries = fs::read_dir(events_dir)
        .map_err(|error| format!("eventsディレクトリの読み込みに失敗しました: {error}"))?;
    for entry in entries.flatten() {
        let event_dir = entry.path();
        if !event_dir.is_dir() {
            continue;
        }
        let event_json = event_dir.join("event.json");
        if !event_json.is_file() {
            continue;
        }
        let text = match fs::read_to_string(&event_json) {
            Ok(text) => text,
            Err(_) => {
                skipped_events += 1;
                continue;
            }
        };
        let data = match serde_json::from_str::<Value>(&text) {
            Ok(data) => data,
            Err(_) => {
                skipped_events += 1;
                continue;
            }
        };
        scanned_events += 1;
        let event = data.get("event").unwrap_or(&Value::Null);
        let event_name = value_text(event.get("name"));
        let event_date = value_text(event.get("date"));
        let parsed_event_date = event_date
            .get(..10)
            .and_then(|date| NaiveDate::parse_from_str(date, "%Y-%m-%d").ok());
        if parsed_event_date.is_some_and(|date| date >= today) {
            excluded_upcoming_events += 1;
            continue;
        }
        let event_dir_text = event_dir.to_string_lossy().replace('\\', "/");

        let Some(circles) = data.get("circles").and_then(Value::as_array) else {
            continue;
        };
        for circle in circles {
            if !circle.is_object() {
                continue;
            }
            scanned_circles += 1;
            let circle_name = value_text(circle.get("name"));
            let penname = value_text(circle.get("penname"));
            let titles = collect_item_titles(circle);

            let circle_match =
                best_text_match(&normalized_query, [circle_name.as_str(), penname.as_str()]);
            let mut matched_titles: Vec<(f64, String)> = titles
                .iter()
                .filter_map(|title| {
                    fuzzy_score(&normalized_query, title).map(|score| (score, title.clone()))
                })
                .collect();
            matched_titles.sort_by(|left, right| {
                right
                    .0
                    .partial_cmp(&left.0)
                    .unwrap_or(Ordering::Equal)
                    .then_with(|| left.1.cmp(&right.1))
            });
            matched_titles.truncate(5);

            let title_match = matched_titles.first().cloned();
            let (score, matched_by, matched_text) = match (circle_match, title_match) {
                (None, None) => continue,
                (Some(circle_hit), Some(title_hit)) if title_hit.0 > circle_hit.0 => {
                    (title_hit.0, "title", title_hit.1)
                }
                (Some(circle_hit), _) => (circle_hit.0, "circle", circle_hit.1),
                (None, Some(title_hit)) => (title_hit.0, "title", title_hit.1),
            };

            results.push(HistorySearchResult {
                event_name: if event_name.is_empty() {
                    entry.file_name().to_string_lossy().to_string()
                } else {
                    event_name.clone()
                },
                event_date: event_date.clone(),
                event_dir: event_dir_text.clone(),
                circle_name: circle_name.clone(),
                penname,
                space: value_text(circle.get("space")),
                hall: value_text(circle.get("hall")),
                matched_by: matched_by.to_string(),
                matched_text,
                matched_titles: matched_titles.into_iter().map(|(_, title)| title).collect(),
                score: (score * 10.0).round() / 10.0,
            });
        }
    }

    results.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(Ordering::Equal)
            .then_with(|| right.event_date.cmp(&left.event_date))
            .then_with(|| left.circle_name.cmp(&right.circle_name))
            .then_with(|| left.event_name.cmp(&right.event_name))
    });
    let total_matches = results.len();
    let effective_limit = limit.clamp(1, MAX_RESULT_LIMIT);
    results.truncate(effective_limit);

    Ok(HistorySearchResponse {
        status: "ok",
        query: query.trim().to_string(),
        normalized_query,
        scanned_events,
        scanned_circles,
        skipped_events,
        excluded_upcoming_events,
        total_matches,
        truncated: total_matches > results.len(),
        results,
    })
}

#[tauri::command]
pub fn search_past_participations(
    project_root: String,
    query: String,
    limit: Option<usize>,
) -> Result<HistorySearchResponse, String> {
    search_events_dir(
        &Path::new(&project_root).join("events"),
        &query,
        limit.unwrap_or(DEFAULT_RESULT_LIMIT),
        Local::now().date_naive(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_events_dir(label: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "eventtrail-history-search-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    fn write_event(events_dir: &Path, slug: &str, data: Value) {
        let dir = events_dir.join(slug);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("event.json"),
            serde_json::to_string_pretty(&data).unwrap(),
        )
        .unwrap();
    }

    fn test_today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 1, 1).unwrap()
    }

    #[test]
    fn normalization_absorbs_width_case_spacing_and_kana() {
        assert_eq!(normalize_search_text(" Ａｂ C！ "), "abc");
        assert_eq!(normalize_search_text("ことのは"), "コトノハ");
        assert_eq!(normalize_search_text("ｺﾄﾉﾊ"), "コトノハ");
    }

    #[test]
    fn fuzzy_score_accepts_partial_and_small_typo_but_rejects_unrelated_text() {
        assert!(fuzzy_score("コトノハ", "ことのは工房").unwrap() > 88.0);
        assert!(fuzzy_score("コトノハフェスタ", "コトノハーズフェスタ").is_some());
        assert!(fuzzy_score("コトノハシマト", "ことのはしまいといっしょ").is_some());
        assert!(fuzzy_score("コトノハシマト", "ことのは").is_none());
        assert!(fuzzy_score("コトノハ", "まったく別の名前").is_none());
    }

    #[test]
    fn search_returns_circle_and_title_matches_in_event_history() {
        let events_dir = temp_events_dir("matches");
        write_event(
            &events_dir,
            "older",
            json!({
                "event": {"name": "過去イベント", "date": "2024-05-03"},
                "circles": [{
                    "name": "ことのは工房",
                    "penname": "作者A",
                    "space": "A-01",
                    "items": [{"name": "琴葉かわいいBOOK3"}]
                }]
            }),
        );
        write_event(
            &events_dir,
            "newer",
            json!({
                "event": {"name": "新しいイベント", "date": "2025-11-02"},
                "circles": [{
                    "name": "別サークル",
                    "items": [{"title": "ことのはしまいといっしょ"}]
                }]
            }),
        );

        let response = search_events_dir(&events_dir, "ことのは", 100, test_today()).unwrap();
        assert_eq!(response.scanned_events, 2);
        assert_eq!(response.scanned_circles, 2);
        assert_eq!(response.total_matches, 2);
        assert_eq!(response.results[0].event_name, "過去イベント");
        assert_eq!(response.results[0].matched_by, "circle");
        assert!(response.results.iter().any(|result| {
            result.matched_by == "title" && result.matched_text == "ことのはしまいといっしょ"
        }));

        fs::remove_dir_all(events_dir).unwrap();
    }

    #[test]
    fn search_sorts_equal_scores_by_newest_event_and_applies_limit() {
        let events_dir = temp_events_dir("sort");
        for (slug, name, date) in [
            ("older", "古いイベント", "2023-01-01"),
            ("newer", "新しいイベント", "2025-01-01"),
        ] {
            write_event(
                &events_dir,
                slug,
                json!({
                    "event": {"name": name, "date": date},
                    "circles": [{"name": "完全一致サークル"}]
                }),
            );
        }

        let response = search_events_dir(&events_dir, "完全一致サークル", 1, test_today()).unwrap();
        assert_eq!(response.total_matches, 2);
        assert!(response.truncated);
        assert_eq!(response.results[0].event_name, "新しいイベント");

        fs::remove_dir_all(events_dir).unwrap();
    }

    #[test]
    fn search_skips_invalid_event_json_and_reports_it() {
        let events_dir = temp_events_dir("invalid");
        let invalid_dir = events_dir.join("broken");
        fs::create_dir_all(&invalid_dir).unwrap();
        fs::write(invalid_dir.join("event.json"), b"{not json").unwrap();
        write_event(
            &events_dir,
            "valid",
            json!({
                "event": {"name": "読めるイベント", "date": "2025-01-01"},
                "circles": [{"name": "テストサークル"}]
            }),
        );

        let response = search_events_dir(&events_dir, "テストサークル", 100, test_today()).unwrap();
        assert_eq!(response.scanned_events, 1);
        assert_eq!(response.skipped_events, 1);
        assert_eq!(response.total_matches, 1);

        fs::remove_dir_all(events_dir).unwrap();
    }

    #[test]
    fn search_requires_two_meaningful_characters() {
        let error =
            search_events_dir(Path::new("missing"), "! あ ", 100, test_today()).unwrap_err();
        assert!(error.contains("2文字以上"));
    }

    #[test]
    fn search_reports_missing_events_directory_as_configuration_error() {
        let error = search_events_dir(
            Path::new("definitely-missing-events-dir"),
            "テスト",
            100,
            test_today(),
        )
        .unwrap_err();
        assert!(error.contains("eventsフォルダが見つかりません"));
    }

    #[test]
    fn search_excludes_events_held_today_or_later() {
        let events_dir = temp_events_dir("upcoming");
        for (slug, name, date) in [
            ("past", "過去イベント", "2025-12-31"),
            ("today", "当日イベント", "2026-01-01"),
            ("future", "未来イベント", "2099-01-01"),
        ] {
            write_event(
                &events_dir,
                slug,
                json!({
                    "event": {"name": name, "date": date},
                    "circles": [{"name": "時系列サークル"}]
                }),
            );
        }

        let response = search_events_dir(&events_dir, "時系列サークル", 100, test_today()).unwrap();
        assert_eq!(response.scanned_events, 3);
        assert_eq!(response.excluded_upcoming_events, 2);
        assert_eq!(response.total_matches, 1);
        assert_eq!(response.results[0].event_name, "過去イベント");

        fs::remove_dir_all(events_dir).unwrap();
    }
}
