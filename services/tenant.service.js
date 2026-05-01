import Tenant from "../models/tenant.model.js";

const generateSlug = (name) => {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-");
};

const generateUniqueSlug = async (baseSlug) => {
  let slug = baseSlug;
  let counter = 1;

  while (await Tenant.findOne({ slug })) {
    slug = `${baseSlug}-${counter}`;
    counter++;
  }

  return slug;
};

const createTenant = async ({ orgName, industry }) => {
  if (!orgName) {
    throw new Error("Organization name is required");
  }

  const baseSlug = generateSlug(orgName);
  const slug = await generateUniqueSlug(baseSlug);

  const tenant = new Tenant({
    orgName,
    industry,
    slug,
  });

  await tenant.save();

  return tenant;
};

export default { createTenant };
