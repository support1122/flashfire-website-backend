/**
 * Safely extracts serializable error details from an error object.
 * Prevents circular reference crashes when storing errors in MongoDB.
 *
 * @param {Error|any} error - The error to serialize
 * @returns {Object} A safe, serializable error details object
 */
export function safeErrorDetails(error) {
  if (!error) return null;

  try {
    const details = {
      message: error.message || String(error),
      code: error.code || undefined,
      status: error.response?.status || undefined,
      statusText: error.response?.statusText || undefined,
      responseBody: error.response?.data || error.response?.body || undefined
    };

    // Verify it can be serialized (catches circular references)
    JSON.stringify(details);
    return details;
  } catch {
    return { message: String(error.message || error) };
  }
}
