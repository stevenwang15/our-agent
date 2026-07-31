// Copyright 2026 my-agent contributors
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// my-agent .conf parser (Rust port of the JS parser)
// Supports both bracket [section] and brace (section.key) styles

use std::collections::HashMap;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AgentData {
    pub name: String,
    pub description: String,
    pub icon: String,
    pub color: String,
    pub system_prompt: String,
    pub welcome: String,
    pub raw_conf: String,
}

/// Parse a .conf string into a flat key-value map
pub fn parse_conf(text: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut current_section = String::new();

    for line in text.lines() {
        let trimmed = line.trim();

        // Skip empty lines and comments
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with("//") {
            continue;
        }

        // Bracket section: [section_name]
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            current_section = trimmed[1..trimmed.len() - 1].trim().to_lowercase();
            continue;
        }

        // Key = value
        if let Some(eq_pos) = trimmed.find('=') {
            let key = trimmed[..eq_pos].trim();
            let value = trimmed[eq_pos + 1..].trim();

            let full_key = if current_section.is_empty() {
                key.to_lowercase()
            } else {
                format!("{}.{}", current_section, key.to_lowercase())
            };

            map.insert(full_key, value.to_string());
        }
    }

    map
}

/// Extract agent data from parsed conf
pub fn extract_agent_data(raw_conf: &str) -> AgentData {
    let map = parse_conf(raw_conf);

    let get_val = |keys: &[&str]| -> String {
        for k in keys {
            if let Some(v) = map.get(*k) {
                return v.clone();
            }
        }
        String::new()
    };

    let name = get_val(&["agent.name", "agent.name", "name"]);
    let description = get_val(&["agent.desc", "agent.desc", "agent.description", "desc"]);
    let icon = get_val(&["ui.icon", "ui.icon", "icon"]);
    let color = get_val(&["ui.color", "ui.color", "color"]);
    let system_prompt = get_val(&["prompt.system", "prompt.system", "system"]);
    let welcome = get_val(&["prompt.welcome", "prompt.welcome", "welcome"]);

    AgentData {
        name: if name.is_empty() { "Agent".to_string() } else { name },
        description,
        icon: if icon.is_empty() { "🤖".to_string() } else { icon },
        color: if color.is_empty() { "#6366f1".to_string() } else { color },
        system_prompt,
        welcome,
        raw_conf: raw_conf.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bracket_style() {
        let text = "[agent]\nname = 翻译助手\ndesc = 中英文翻译\n\n[prompt]\nsystem = 你是翻译专家\nwelcome = 请输入内容\n\n[ui]\nicon = 🌐\ncolor = #22c55e";
        let data = extract_agent_data(text);
        assert_eq!(data.name, "翻译助手");
        assert_eq!(data.description, "中英文翻译");
        assert_eq!(data.system_prompt, "你是翻译专家");
        assert_eq!(data.icon, "🌐");
    }

    #[test]
    fn test_brace_style() {
        let text = "agent.name = 测试助手\nagent.desc = 测试用\nprompt.system = 你好\nui.icon = 🤖";
        let data = extract_agent_data(text);
        assert_eq!(data.name, "测试助手");
        assert_eq!(data.system_prompt, "你好");
    }
}
