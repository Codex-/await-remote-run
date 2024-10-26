export type Result<T> = ResultSuccess<T> | ResultFailure;

interface ResultSuccess<T> {
  success: true;
  value: T;
}

interface ResultFailure {
  success: false;
  reason: "timeout" | "inconclusive" | "unsupported";
}
