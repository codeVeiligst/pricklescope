export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export const unauthorized = (): HttpError =>
  new HttpError(401, 'unauthorized', 'Authentication is required')

export const forbidden = (): HttpError =>
  new HttpError(403, 'forbidden', 'You do not have permission to perform this action')
