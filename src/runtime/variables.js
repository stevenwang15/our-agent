// my-agent - (c) 2026 Apache-2.0 - See LICENSE file for details
/**
 * Variable substitution for .conf files.
 * Supports: ${ENV_VAR}, ${ENV_VAR:-default}, ${ENV_VAR:?error message}
 */

export function substituteVars(value, extraVars = {}) {
  if (typeof value !== 'string') return value;

  return value.replace(/\$\{([^}]+)\}/g, (match, expr) => {
    const parts = expr.split(/:(?=[-?])/);
    const varName = parts[0].trim();
    const operator = parts[1] ? parts[1][0] : '';
    const defaultValue = parts[1] ? parts[1].slice(1) : '';

    // Check extra vars first (runtime overrides)
    let resolved = extraVars[varName] !== undefined ? String(extraVars[varName]) : undefined;
    
    // Then env vars
    if (resolved === undefined) {
      resolved = process.env[varName];
    }

    if (resolved !== undefined) {
      return resolved;
    }

    // Handle operators
    if (operator === '-') {
      // ${VAR:-default} - use default if unset
      return defaultValue;
    } else if (operator === '?') {
      // ${VAR:?error} - error if unset
      throw new Error(`Variable ${varName} is required: ${defaultValue || 'not set'}`);
    }

    // ${VAR} - undefined but no operator, return empty string
    return '';
  });
}

export function substituteConf(confDoc, extraVars = {}) {
  // Walk through all sections and substitute values
  for (const [sectionName, sectionMap] of confDoc.sections) {
    for (const [key, confValue] of sectionMap) {
      if (confValue.type === 'string') {
        try {
          confValue.value = substituteVars(confValue.value, extraVars);
        } catch (e) {
          throw new Error(`In [${sectionName}].${key}: ${e.message}`);
        }
      } else if (confValue.type === 'array') {
        confValue.value = confValue.value.map(v => {
          if (v.type === 'string') {
            v.value = substituteVars(v.value, extraVars);
          }
          return v;
        });
      }
    }
  }
  return confDoc;
}
