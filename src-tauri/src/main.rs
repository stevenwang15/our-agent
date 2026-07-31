// my-agent - (c) 2026 Apache-2.0 - See LICENSE file for details
// Tauri desktop app with embedded Axum API server
// Static files are served by Tauri's asset protocol from distDir

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod conf;

use axum::{
    body::Body,
    extract::State,
    http::StatusCode,
    routing::{get, post},
    Json,
    Router,
};
use futures_util::stream::StreamExt;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tower_http::cors::CorsLayer;

const API_PORT: u16 = 17365;

// ---- Shared state ----

struct AppState {
    agent_conf: Option<String>,
}

// ---- API types ----

#[derive(Deserialize)]
struct LoadConfRequest {
    content: String,
}

#[derive(Serialize)]
struct LoadConfResponse {
    success: bool,
    agent: Option<conf::AgentData>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct ChatRequest {
    prompt: ChatPrompt,
    api_key: String,
    base_url: Option<String>,
    model: Option<String>,
}

#[derive(Deserialize)]
struct ChatPrompt {
    system_prompt: Option<String>,
    user_input: Option<String>,
}

// ---- Helpers ----

fn sse_error(msg: String) -> axum::http::Response<Body> {
    axum::http::Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "text/event-stream")
        .header("Access-Control-Allow-Origin", "*")
        .body(Body::from(format!(
            "data: {}\n\n",
            serde_json::json!({ "error": msg })
        )))
        .unwrap()
}

// ---- Handlers ----

async fn handle_status() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true, "version": "1.0.0" }))
}

async fn handle_current_agent(
    State(state): State<Arc<AppState>>,
) -> Json<LoadConfResponse> {
    match &state.agent_conf {
        Some(content) => {
            let agent = conf::extract_agent_data(content);
            Json(LoadConfResponse {
                success: true,
                agent: Some(agent),
                error: None,
            })
        }
        None => Json(LoadConfResponse {
            success: false,
            agent: None,
            error: Some("No agent.conf found".into()),
        }),
    }
}

async fn handle_load_conf(
    State(_state): State<Arc<AppState>>,
    axum::Json(req): axum::Json<LoadConfRequest>,
) -> Json<LoadConfResponse> {
    let agent = conf::extract_agent_data(&req.content);
    Json(LoadConfResponse {
        success: true,
        agent: Some(agent),
        error: None,
    })
}

async fn handle_chat(
    State(_state): State<Arc<AppState>>,
    axum::Json(req): axum::Json<ChatRequest>,
) -> axum::http::Response<Body> {
    let api_key = req.api_key;
    let base_url = req
        .base_url
        .unwrap_or_else(|| "https://api.openai.com/v1".to_string());
    let model = req.model.unwrap_or_else(|| "gpt-4o".to_string());

    if api_key.is_empty() {
        return sse_error("API key required".into());
    }

    let mut messages: Vec<serde_json::Value> = Vec::new();
    if let Some(s) = &req.prompt.system_prompt {
        if !s.is_empty() {
            messages.push(serde_json::json!({ "role": "system", "content": s }));
        }
    }
    if let Some(s) = &req.prompt.user_input {
        if !s.is_empty() {
            messages.push(serde_json::json!({ "role": "user", "content": s }));
        }
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .unwrap();

    let api_url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let req_body = serde_json::json!({ "model": model, "messages": messages, "stream": true });

    match client
        .post(&api_url)
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&req_body)
        .send()
        .await
    {
        Ok(resp) => {
            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                let truncated = text.chars().take(200).collect::<String>();
                return sse_error(format!("API {}: {}", status, truncated));
            }

            let stream = resp.bytes_stream();
            let sse = stream.map(move |chunk| {
                match chunk {
                    Ok(bytes) => {
                        let text = String::from_utf8_lossy(&bytes);
                        let mut out = String::new();
                        for line in text.lines() {
                            let t = line.trim();
                            if t.starts_with("data: ") {
                                let payload = &t[6..];
                                if payload == "[DONE]" {
                                    continue;
                                }
                                if let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) {
                                    if let Some(delta) = v
                                        .pointer("/choices/0/delta/content")
                                        .and_then(|v| v.as_str())
                                    {
                                        out.push_str(&format!(
                                            "data: {}\n\n",
                                            serde_json::json!({ "text": delta })
                                        ));
                                    }
                                }
                            }
                        }
                        if out.is_empty() {
                            out = format!("data: {}\n\n", serde_json::json!({ "text": text }));
                        }
                        Ok::<_, std::convert::Infallible>(out)
                    }
                    Err(e) => Ok(format!(
                        "data: {}\n\n",
                        serde_json::json!({ "error": e.to_string() })
                    )),
                }
            });

            axum::http::Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", "text/event-stream")
                .header("Cache-Control", "no-cache")
                .header("Connection", "keep-alive")
                .header("Access-Control-Allow-Origin", "*")
                .body(Body::from_stream(sse))
                .unwrap()
        }
        Err(e) => sse_error(e.to_string()),
    }
}

// ---- Main ----

fn main() {
    // Load agent.conf if it exists (embedded during build)
    let agent_conf = std::fs::read_to_string("agent.conf").ok();

    // Start the API server in a background thread
    let state = Arc::new(AppState { agent_conf });
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let app = Router::new()
                .route("/api/status", get(handle_status))
                .route("/api/current-agent", get(handle_current_agent))
                .route("/api/load-conf", post(handle_load_conf))
                .route("/api/agent", post(handle_chat))
                .layer(CorsLayer::permissive())
                .with_state(state);

            let addr: std::net::SocketAddr = ([127, 0, 0, 1], API_PORT).into();
            println!("[my-agent] API server on http://127.0.0.1:{}", API_PORT);

            axum::serve(
                tokio::net::TcpListener::bind(addr).await.unwrap(),
                app,
            )
            .await
            .unwrap();
        });
    });

    // Run Tauri (loads static files from distDir)
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
