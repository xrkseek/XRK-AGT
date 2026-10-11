export type ModuleImportErrorKind =
  | 'missing_package'
  | 'missing_file'
  | 'missing_export'
  | 'other';

export type ClassifiedModuleImportError = {
  kind: ModuleImportErrorKind;
  packageName?: string;
  filePath?: string;
  exportName?: string;
  message: string;
};

/**
 * Classify Node ESM/CJS module load failures for plugin/HTTP loaders and tests.
 */
export function classifyModuleImportError(err: unknown): ClassifiedModuleImportError {
  const message = isErrorLike(err) ? err.message : String(err ?? '');
  const stack = isErrorLike(err) && typeof err.stack === 'string' ? err.stack : '';
  const text = `${message}\n${stack}`;

  let m = text.match(/Cannot find package ['"]([^'"]+)['"]/i);
  if (m) {
    return { kind: 'missing_package', packageName: m[1], message };
  }

  m = text.match(/Cannot find module ['"]([^'"]+)['"]/i);
  if (m) {
    const spec = m[1];
    if (isLocalModuleSpecifier(spec)) {
      return { kind: 'missing_file', filePath: spec, message };
    }
    return {
      kind: 'missing_package',
      packageName: normalizePackageSpecifier(spec),
      message,
    };
  }

  m = text.match(/does not provide an export named ['"]([^'"]+)['"]/i);
  if (m) {
    const mod = text.match(/requested module ['"]([^'"]+)['"]/i);
    return {
      kind: 'missing_export',
      exportName: m[1],
      packageName: mod?.[1],
      message,
    };
  }

  return { kind: 'other', message };
}

type ErrorConstructorWithIsError = ErrorConstructor & {
  isError?: (value: unknown) => value is Error;
};

function isErrorLike(err: unknown): err is { message: string; stack?: string } {
  const Ctor = Error as ErrorConstructorWithIsError;
  if (typeof Ctor.isError === 'function') return Ctor.isError(err);
  return Boolean(err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string');
}

/** Absolute / relative / #alias specs are not npm package names. */
function isLocalModuleSpecifier(spec: string): boolean {
  if (!spec) return false;
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('#') || pathIsAbsolute(spec)) {
    return true;
  }
  if (spec.includes('\\') || /[/\\]\.(js|mjs|cjs|json|node)$/i.test(spec)) {
    return true;
  }
  return false;
}

function normalizePackageSpecifier(spec: string): string {
  if (!spec || isLocalModuleSpecifier(spec)) {
    return spec;
  }
  if (spec.startsWith('@')) {
    const parts = spec.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : spec;
  }
  return spec.split('/')[0] || spec;
}

function pathIsAbsolute(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/');
}

export function extractMissingPackageName(err: unknown): string | null {
  const c = classifyModuleImportError(err);
  return c.kind === 'missing_package' ? (c.packageName || null) : null;
}

/** 是否应归入「缺少 npm 依赖」提示（而非普通代码错误） */
export function isMissingPackageError(err: unknown): boolean {
  return classifyModuleImportError(err).kind === 'missing_package';
}
