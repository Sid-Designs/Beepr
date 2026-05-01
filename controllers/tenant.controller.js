import tenantService from "../services/tenant.service.js";

const registerTenant = async (req, res, next) => {
  try {
    const { orgName, industry } = req.body;

    const tenant = await tenantService.createTenant({
      orgName,
      industry,
    });

    res.status(201).json({
      success: true,
      data: tenant,
    });
  } catch (error) {
    next(error);
  }
};

export default { registerTenant };
