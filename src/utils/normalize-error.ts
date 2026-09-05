type ErrorConstructorWithIsError = ErrorConstructor & {
  isError?: (value: unknown) => value is Error;
};

export function normalizeError(err: unknown): Error {
  const Ctor = Error as ErrorConstructorWithIsError;
  if (typeof Ctor.isError === 'function' && Ctor.isError(err)) return err;
  if (err instanceof Error) return err;
  return new Error(String(err));
}
