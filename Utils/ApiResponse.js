export class ApiError extends Error {
  constructor(message, statusCode = 500, details = null) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.name = 'ApiError';
  }
}

export const handleControllerError = (res, error) => {
  const statusCode = error.statusCode || 500;
  const response = {
    success: false,
    message: error.message || 'Internal server error'
  };

  if (process.env.NODE_ENV === 'development') {
    response.stack = error.stack;
    if (error.details) {
      response.details = error.details;
    }
  }

  return res.status(statusCode).json(response);
};

export const successResponse = (res, data, message = null, statusCode = 200) => {
  const response = {
    success: true
  };

  if (message) {
    response.message = message;
  }

  if (data !== undefined) {
    response.data = data;
  }

  return res.status(statusCode).json(response);
};

export const errorResponse = (res, message, statusCode = 500, details = null) => {
  const response = {
    success: false,
    message
  };

  if (details && process.env.NODE_ENV === 'development') {
    response.details = details;
  }

  return res.status(statusCode).json(response);
};
