import Transaction from '../model/transaction.model.js';
import { validateUserExists, validateBodyUser } from '../utils/userValidation.js';
import User from '../model/user.model.js';
import { getTokenPrice } from '../utils/priceService.js';
import { createNotification } from '../utils/notificationHelper.js';
import { createAuditLog } from '../utils/auditHelper.js';
import { invalidateAuditCache } from './audit-log.controller.js';
import logger from '../utils/logger.js';
import mongoose from 'mongoose';

class DepositController {
  // Get all deposits for a specific user
  static async getUserDeposits(req, res) {
    try {
        const { userId } = req.params;

        const validation = await validateUserExists(userId);
        if (!validation.ok) {
          return res.status(validation.status).json({ success: false, message: validation.message });
        }

        const deposits = await Transaction.find({ user: userId, isDeposit: true }).sort({ createdAt: -1 });
      
      res.json({
        success: true,
        data: deposits,
        count: deposits.length
      });
    } catch (error) {
      console.error('Error fetching user deposits:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch deposits',
        error: error.message
      });
    }
  }

  // Get all deposits (admin only)
  static async getAllDeposits(req, res) {
    try {
      logger.info('💰 Fetching all deposits', {
        adminUsername: req.admin?.username
      });

      const deposits = await Transaction.find({ 
        isDeposit: true 
      }).sort({ createdAt: -1 });

      // Create audit log
      await createAuditLog(req, res, {
        action: 'deposits_view_all',
        resourceType: 'deposit',
        description: `Admin ${req.admin?.username || 'unknown'} viewed all deposits (${deposits.length} deposits)`
      });

      // Invalidate audit cache
      await invalidateAuditCache();

      logger.info('✅ Deposits retrieved successfully', {
        adminUsername: req.admin?.username,
        count: deposits.length
      });
      
      res.json({
        success: true,
        data: deposits,
        count: deposits.length
      });
    } catch (error) {
      logger.error('❌ Error fetching deposits', {
        error: error.message,
        adminId: req.admin?.id
      });
      console.error('Error fetching all deposits:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch deposits',
        error: error.message
      });
    }
  }

  // Create new deposit
  static async createDeposit(req, res) {
    try {
      const { token_name, amount, token_deposit_address, user, status } = req.body;

      // Validate required fields
      if (!token_name || !amount || !user) {
        return res.status(400).json({
          success: false,
          message: 'Required fields: token_name, amount, user'
        });
      }

      const validation = await validateBodyUser(user);
      if (!validation.ok) {
        return res.status(validation.status).json({ success: false, message: validation.message });
      }

      const deposit = new Transaction({
        token_name,
        isWithdraw: false,
        isDeposit: true,
        amount,
        token_deposit_address,
        user,
        status: status || 'pending'
      });

      const savedDeposit = await deposit.save();

      // Create notification for admin
      await createNotification({
        action: 'deposit',
        userId: user,
        metadata: {
          amount,
          currency: token_name,
          referenceId: savedDeposit._id.toString()
        }
      });

      res.status(201).json({
        success: true,
        message: 'Deposit created successfully',
        data: savedDeposit
      });
    } catch (error) {
      console.error('Error creating deposit:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to create deposit',
        error: error.message
      });
    }
  }

  // Update deposit
  static async updateDeposit(req, res) {
    try {
      const { id } = req.params;
      const updateData = { ...req.body };

      logger.info('📝 Updating deposit', {
        depositId: id,
        adminUsername: req.admin?.username,
        updates: Object.keys(updateData)
      });

      // Ensure this remains a deposit
      updateData.isDeposit = true;
      updateData.isWithdraw = false;
      const existing = await Transaction.findOne({ _id: id, isDeposit: true });
      if (!existing) {
        logger.warn('⚠️ Deposit not found', {
          depositId: id,
          adminUsername: req.admin?.username
        });
        return res.status(404).json({ success: false, message: 'Deposit not found' });
      }

      const prevStatus = existing.status;

      // Prevent editing amount/token once already approved
      if (prevStatus === 'approved') {
        const amountChange = updateData.amount !== undefined && updateData.amount !== existing.amount;
        const tokenChange = updateData.token_name && updateData.token_name !== existing.token_name;
        if (amountChange || tokenChange) {
          logger.warn('⚠️ Cannot modify approved deposit', {
            depositId: id,
            adminUsername: req.admin?.username,
            currentStatus: prevStatus
          });
          return res.status(400).json({ success: false, message: 'Cannot modify amount or token_name after approval' });
        }
      }

      // Apply allowed updates
      if (updateData.status) existing.status = updateData.status;
      if (prevStatus !== 'approved') { // only editable pre-approval
        if (updateData.amount !== undefined) existing.amount = updateData.amount;
        if (updateData.token_name) existing.token_name = updateData.token_name;
      }
      if (updateData.token_deposit_address) existing.token_deposit_address = updateData.token_deposit_address;

      const approving = prevStatus !== 'approved' && existing.status === 'approved';

      if (approving) {
        logger.info('✅ Approving deposit', {
          depositId: id,
          adminUsername: req.admin?.username,
          amount: existing.amount,
          token: existing.token_name
        });

        const session = await mongoose.startSession();
        try {
          await session.withTransaction(async () => {
            const price = await getTokenPrice(existing.token_name);
            const usdValue = Number((price * existing.amount).toFixed(8));
            const userDoc = await User.findById(existing.user).select('totalInvestment').session(session);
            if (!userDoc) throw new Error('USER_NOT_FOUND');

            // Persist snapshot fields ONLY if not already set
            if (!existing.usdValue) {
              existing.tokenPriceAtApproval = Number(price);
              existing.usdValue = usdValue;
              existing.approvedAt = new Date();
            }

            const previousBalance = userDoc.totalInvestment || 0;
            userDoc.totalInvestment = Number((previousBalance + usdValue).toFixed(8));
            await userDoc.save({ session });
            await existing.save({ session });
            existing.usdValue = usdValue;

            logger.info('💰 Deposit approved and funds added', {
              depositId: id,
              adminUsername: req.admin?.username,
              usdValueAdded: usdValue,
              previousBalance,
              newBalance: userDoc.totalInvestment
            });
          });
        } catch (err) {
          session.endSession();
          if (err.message === 'USER_NOT_FOUND') {
            logger.error('❌ User not found for deposit approval', {
              depositId: id,
              userId: existing.user,
              adminUsername: req.admin?.username
            });
            return res.status(404).json({ success: false, message: 'User not found for transaction' });
          }
          if (err.response || err.message?.toLowerCase().includes('price')) {
            logger.error('❌ Price service error during deposit approval', {
              error: err.message,
              depositId: id,
              token: existing.token_name
            });
            return res.status(502).json({ success: false, message: 'Failed to fetch token price', error: err.message });
          }
          logger.error('❌ Transaction error during deposit approval', {
            error: err.message,
            depositId: id,
            adminUsername: req.admin?.username
          });
          return res.status(500).json({ success: false, message: 'Failed during approval transaction', error: err.message });
        } finally {
          session.endSession();
        }
      } else {
        await existing.save();
      }

      // Create audit log for deposit update
      const statusChanged = prevStatus !== existing.status;
      const actionType = statusChanged ? 'deposit_status_changed' : 'deposit_updated';
      
      await createAuditLog(req, res, {
        action: actionType,
        resourceType: 'deposit',
        resourceId: existing._id.toString(),
        resourceName: `${existing.token_name} deposit - ${existing.amount}`,
        changes: {
          before: { 
            status: prevStatus,
            amount: req.body.amount !== undefined ? (existing.amount - (req.body.amount - existing.amount)) : existing.amount,
            token_name: req.body.token_name ? (existing.token_name === req.body.token_name ? existing.token_name : 'changed') : existing.token_name
          },
          after: { 
            status: existing.status,
            amount: existing.amount,
            token_name: existing.token_name
          }
        },
        description: statusChanged ? 
          `Deposit status changed from ${prevStatus} to ${existing.status} for ${existing.token_name} ${existing.amount}` :
          `Updated deposit: ${existing.token_name} ${existing.amount}`
      });

      // Invalidate audit cache
      await invalidateAuditCache();

      logger.info('✅ Deposit updated successfully', {
        depositId: id,
        adminUsername: req.admin?.username,
        newStatus: existing.status,
        tokenName: existing.token_name,
        amount: existing.amount
      });

      return res.json({
        success: true,
        message: 'Deposit updated successfully',
        data: existing,
        ...(existing.usdValue ? { usdValueAdded: existing.usdValue } : {})
      });
    } catch (error) {
      logger.error('❌ Error updating deposit', {
        error: error.message,
        depositId: req.params.id,
        adminId: req.admin?.id
      });
      console.error('Error updating deposit:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to update deposit',
        error: error.message
      });
    }
  }

  // Delete deposit
  static async deleteDeposit(req, res) {
    try {
      const { id } = req.params;

      logger.info('🗑️ Deleting deposit', {
        depositId: id,
        adminUsername: req.admin?.username
      });

      // Get deposit data before deletion for audit
      const depositToDelete = await Transaction.findOne({
        _id: id,
        isDeposit: true
      });

      if (!depositToDelete) {
        logger.warn('⚠️ Deposit not found for deletion', {
          depositId: id,
          adminUsername: req.admin?.username
        });
        return res.status(404).json({
          success: false,
          message: 'Deposit not found'
        });
      }

      const deletedDeposit = await Transaction.findOneAndDelete({
        _id: id,
        isDeposit: true
      });

      // Create audit log
      await createAuditLog(req, res, {
        action: 'deposit_deleted',
        resourceType: 'deposit',
        resourceId: id,
        resourceName: `${depositToDelete.token_name} deposit - ${depositToDelete.amount}`,
        deletedData: depositToDelete.toObject(),
        description: `Deleted deposit: ${depositToDelete.token_name} ${depositToDelete.amount} (Status: ${depositToDelete.status})`
      });

      // Invalidate audit cache
      await invalidateAuditCache();

      logger.info('✅ Deposit deleted successfully', {
        depositId: id,
        adminUsername: req.admin?.username,
        tokenName: depositToDelete.token_name,
        amount: depositToDelete.amount,
        status: depositToDelete.status
      });

      res.json({
        success: true,
        message: 'Deposit deleted successfully',
        data: deletedDeposit
      });
    } catch (error) {
      logger.error('❌ Error deleting deposit', {
        error: error.message,
        depositId: req.params.id,
        adminId: req.admin?.id
      });
      console.error('Error deleting deposit:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to delete deposit',
        error: error.message
      });
    }
  }

  // Get deposit by ID
  static async getDepositById(req, res) {
    try {
      const { id } = req.params;

      const deposit = await Transaction.findOne({
        _id: id,
        isDeposit: true
      });

      if (!deposit) {
        return res.status(404).json({
          success: false,
          message: 'Deposit not found'
        });
      }

      res.json({
        success: true,
        data: deposit
      });
    } catch (error) {
      console.error('Error fetching deposit:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch deposit',
        error: error.message
      });
    }
  }

  // Get deposits by status for a user
  static async getUserDepositsByStatus(req, res) {
    try {
      const { userId, status } = req.params;

      const validation = await validateUserExists(userId);
      if (!validation.ok) {
        return res.status(validation.status).json({ success: false, message: validation.message });
      }

      const deposits = await Transaction.find({
        user: userId,
        isDeposit: true,
        status
      }).sort({ createdAt: -1 });

      res.json({
        success: true,
        data: deposits,
        count: deposits.length
      });
    } catch (error) {
      console.error('Error fetching user deposits by status:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch deposits by status',
        error: error.message
      });
    }
  }
}

export default DepositController;