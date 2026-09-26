import { Logger } from '@nestjs/common';

// Keep test output readable: expected warnings (e.g. failing health checks) are
// asserted on behaviour, not printed.
Logger.overrideLogger(false);
