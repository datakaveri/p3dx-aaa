export default function errorMiddleware(err, req, res, next) {
  console.error(err);

  // Axios/Keycloak errors
  if (err?.response?.status) {
    const status = err.response.status;

    // Keycloak token endpoint commonly returns 400 for invalid_grant
    if (status === 400 || status === 401) {
      return res.status(401).json({ status: 'FAILED', error: 'INVALID_CREDENTIALS' });
    }

    return res.status(status).json({ status: 'FAILED', error: 'UPSTREAM_ERROR' });
  }

  if (err?.message === 'USER_NOT_FOUND') {
    return res.status(404).json({ status: 'FAILED', error: 'USER_NOT_FOUND' });
  }

  res.status(500).json({ status: 'FAILED', error: 'INTERNAL_ERROR' });
}
