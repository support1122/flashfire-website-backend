import { EmailTemplateModel } from '../Schema_Models/EmailTemplate.js';

// ==================== SAVE EMAIL TEMPLATE ====================
export const saveEmailTemplate = async (req, res) => {
  try {
    const { templateId, templateName, domainName } = req.body;

    if (!templateId || !templateName || !domainName) {
      return res.status(400).json({
        success: false,
        message: 'Template ID, Template Name, and Domain Name are required'
      });
    }

    // Check if template already exists
    const existingTemplate = await EmailTemplateModel.findOne({
      templateId: templateId.trim(),
      domainName: domainName.trim()
    });

    if (existingTemplate) {
      // Update existing template
      existingTemplate.templateName = templateName.trim();
      existingTemplate.updatedAt = new Date();
      await existingTemplate.save();

      return res.status(200).json({
        success: true,
        message: 'Email template updated successfully',
        data: existingTemplate
      });
    }

    // Create new template
    const template = new EmailTemplateModel({
      templateId: templateId.trim(),
      templateName: templateName.trim(),
      domainName: domainName.trim()
    });

    await template.save();

    return res.status(201).json({
      success: true,
      message: 'Email template saved successfully',
      data: template
    });

  } catch (error) {
    console.error('Error saving email template:', error);
    
    // Handle duplicate key error
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Template with this ID and Domain already exists'
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Failed to save email template',
      error: error.message
    });
  }
};

// ==================== GET ALL EMAIL TEMPLATES ====================
export const getEmailTemplates = async (req, res) => {
  try {
    const templates = await EmailTemplateModel.find()
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      templates: templates.map(template => ({
        id: template._id?.toString() || template.templateId,
        name: template.templateName,
        domainName: template.domainName,
        templateId: template.templateId,
        createdAt: template.createdAt
      }))
    });

  } catch (error) {
    console.error('Error fetching email templates:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch email templates',
      error: error.message
    });
  }
};

// ==================== DELETE EMAIL TEMPLATE ====================
export const deleteEmailTemplate = async (req, res) => {
  try {
    const { templateId } = req.params;
    const { domainName } = req.query;

    if (!templateId || !domainName) {
      return res.status(400).json({
        success: false,
        message: 'Template ID and Domain Name are required'
      });
    }

    const template = await EmailTemplateModel.findOneAndDelete({
      templateId: templateId.trim(),
      domainName: domainName.trim()
    });

    if (!template) {
      return res.status(404).json({
        success: false,
        message: 'Template not found'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Email template deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting email template:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete email template',
      error: error.message
    });
  }
};

