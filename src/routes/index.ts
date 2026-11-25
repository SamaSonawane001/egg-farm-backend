import { Router } from 'express';
import { auth, farmContext } from '../middlewares/auth';
import { uploadAvatar, uploadProfileAsset, uploadProfileAvatar } from '../middlewares/upload';
import * as A from '../controllers/auth.controller';
import * as F from '../controllers/flock.controller';
import * as D from '../controllers/feed.controller';
import * as E from '../controllers/egg.controller';
import * as I from '../controllers/invoice.controller';
import * as RM from '../controllers/rawMaterial.controller';
import * as M from '../controllers/medicine.controller';
import * as X from '../controllers/expense.controller';
import * as FX from '../controllers/farmExpense.controller';
import { dashboard } from '../controllers/dashboard.controller';
import { health } from '../controllers/health.controller';
import * as U from '../controllers/upload.controller';
import * as Farm from '../controllers/farm.controller';
import { loginLimiter, otpIpLimiter, otpPhoneLimiter } from '../middlewares/rateLimit';
import subscriptionRoutes from './subscription.routes';

const r = Router();

// ---- public ----
r.post('/auth/send-signup-otp', otpIpLimiter, otpPhoneLimiter, A.sendSignupOtp);
r.post('/auth/verify-signup-otp', A.verifySignupOtp);
r.post('/auth/send-reset-otp', otpIpLimiter, otpPhoneLimiter, A.sendResetOtp);
r.post('/auth/reset-password', A.resetPassword);
r.post('/auth/register', uploadAvatar, A.register);
r.post('/auth/login', loginLimiter, A.login);
r.get('/public/invoices/:id/pdf', I.publicPdf);
r.get('/health', health);

// ---- everything below requires a valid JWT; req.ownerId is the tenant ----
r.use(auth, farmContext);
r.use('/subscription', subscriptionRoutes);
r.get('/auth/me', A.me);
r.get('/farms', Farm.list);
r.post('/farms', Farm.create);
r.put('/farms/:farmId([0-9a-fA-F-]{36})', Farm.renameUnit);
r.put('/profile', uploadProfileAvatar, A.updateProfile);
r.patch('/profile/inventory-mode', A.updateInventoryMode);
r.post('/profile/upload-avatar', uploadProfileAvatar, U.avatar);
r.post('/profile/assets/:asset', uploadProfileAsset, A.uploadFarmAssetImage);
r.delete('/profile/assets/:asset', A.removeFarmAsset);
r.get('/farm/profile', A.me);
r.put('/farm/profile', uploadProfileAvatar, A.updateProfile);
r.post('/farm/profile/assets/:asset', uploadProfileAsset, A.uploadFarmAssetImage);
r.delete('/farm/profile/assets/:asset', A.removeFarmAsset);
r.post('/farm/signature', uploadProfileAsset, A.uploadFarmSignature);
r.delete('/farm/signature', A.removeFarmSignature);
r.post('/farm/payment-qr', uploadProfileAsset, A.uploadFarmPaymentQr);
r.delete('/farm/payment-qr', A.removeFarmPaymentQr);
r.post('/profile/password', A.changePassword);
r.get('/dashboard', dashboard);
r.get('/expenses/monthly-breakdown', X.monthlyBreakdownController);
r.get('/farm-expenses', FX.list);
r.post('/farm-expenses', FX.create);
r.put('/farm-expenses/:id', FX.update);
r.delete('/farm-expenses/:id', FX.remove);

r.get('/flock/batches', F.listBatches);
r.post('/flock/batches', F.createBatch);
r.put('/flock/batches/:id', F.updateBatch);
r.delete('/flock/batches/:id', F.deleteBatch);
r.get('/flock/mortality', F.listMortality);
r.post('/flock/mortality', F.createMortality);
r.put('/flock/mortality/:id', F.updateMortality);
r.delete('/flock/mortality/:id', F.deleteMortality);

r.get('/feed', D.products);
r.get('/feed/stock', D.stock);
r.get('/feed/products', D.products);
r.get('/feed/ready-feed', D.readyFeedDetail);
r.post('/feed/prepare-ready-feed', D.prepareReadyFeed);
r.put('/feed/prepare-ready-feed/:id', D.updateReadyFeedPreparation);
r.delete('/feed/prepare-ready-feed/:id', D.deleteReadyFeedPreparation);
r.put('/feed/ready-feed/preparations/:id', D.updateReadyFeedPreparation);
r.delete('/feed/ready-feed/preparations/:id', D.deleteReadyFeedPreparation);
r.post('/feed/products', D.createProduct);
r.get('/feed/products/:id', D.productDetail);
r.put('/feed/products/:id', D.updateProduct);
r.delete('/feed/products/:id', D.removeProduct);
r.get('/feed/purchases', D.listPurchases);
r.post('/feed/purchases', D.createPurchase);
r.put('/feed/purchases/:id', D.updatePurchase);
r.delete('/feed/purchases/:id', D.deletePurchase);
r.get('/feed/usage', D.listUsage);
r.post('/feed/usage', D.createUsage);
r.put('/feed/usage/:id', D.updateUsage);
r.delete('/feed/usage/:id', D.deleteUsage);

r.get('/raw-materials', RM.list);
r.post('/raw-materials', RM.create);
r.put('/raw-materials/:id', RM.update);
r.delete('/raw-materials/:id', RM.remove);
r.post('/raw-materials/inward', RM.inward);
r.put('/raw-materials/inward/:id', RM.updateInward);
r.delete('/raw-materials/inward/:id', RM.removeInward);
r.put('/raw-materials/usage/:id', RM.updateUsage);
r.delete('/raw-materials/usage/:id', RM.removeUsage);
r.get('/raw-materials/logs', RM.logs);
r.get('/raw-materials/processing', RM.processing);
r.delete('/raw-materials/processing/:id', RM.removeProcessing);
r.get('/raw-materials/:id', RM.details);
r.post('/raw-materials/processing', RM.createProcessing);

r.get('/medicines', M.list);
r.post('/medicines', M.create);
r.get('/medicines/:id/details', M.details);
r.post('/medicines/:id/stock', M.stockForMedicine);
r.put('/medicines/:id/stock/:batchId', M.updateStockForMedicine);
r.delete('/medicines/:id/stock/:batchId', M.deleteStockForMedicine);
r.post('/medicines/:id/usage', M.usageForMedicine);
r.put('/medicines/:id', M.update);
r.delete('/medicines/:id', M.remove);
r.post('/medicines/inward', M.inward);
r.post('/medicines/usage', M.usage);
r.get('/medicines/usage', M.listUsage);
r.get('/medicines/logs', M.logs);

r.get('/eggs', E.list);
r.get('/eggs/stock', E.stock);
r.get('/eggs/summary', E.summary);
r.get('/eggs/monthly', E.monthly);
r.get('/eggs/months', E.months);
r.post('/eggs', E.create);
r.put('/eggs/:id', E.update);
r.delete('/eggs/:id', E.remove);

r.get('/invoices/payment-summary', I.paymentSummary);
r.get('/invoices', I.list);
r.post('/invoices', I.create);
r.patch(
  '/invoices/:id([0-9a-fA-F-]{36})/payment-status',
  I.updatePaymentStatus,
);
r.get('/invoices/:id([0-9a-fA-F-]{36})/pdf', I.pdf);
r.get('/invoices/:id([0-9a-fA-F-]{36})', I.getOne);
r.delete('/invoices/:id([0-9a-fA-F-]{36})', I.remove);

export default r;
