import cors from 'cors';
import compression from 'compression';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import { env } from './config/env';
import { errorHandler, notFound } from './middlewares/error';
import routes from './routes';
import customerRoutes from './routes/customer.routes';

const app = express();
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(compression());
const corsOrigins = env.corsOrigin.split(',').map((origin) => origin.trim()).filter(Boolean);
app.use(cors({
  origin: corsOrigins.length === 0 || corsOrigins.includes('*') ? true : corsOrigins,
}));
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/api/customers', customerRoutes);
app.use('/api', routes);
app.use(notFound);
app.use(errorHandler);

export default app;
