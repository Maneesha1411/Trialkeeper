const pool = require("../config/db");

const getOwnProfile = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, role, skill_tags
       FROM users
       WHERE id = $1`,
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "Profile not found.",
      });
    }

    return res.status(200).json({
      user: result.rows[0],
    });
  } catch (error) {
    console.error("Profile lookup error:", error.message);

    return res.status(500).json({
      message: "Could not retrieve profile due to a server error.",
    });
  }
};

const updateOwnProfile = async (req, res) => {
  const updates = req.body;

  if (
    !updates ||
    typeof updates !== "object" ||
    Array.isArray(updates)
  ) {
    return res.status(400).json({
      message: "Request body must be a JSON object.",
    });
  }

  if (Object.hasOwn(updates, "role")) {
    return res.status(400).json({
      message: "Role cannot be changed through the profile API.",
    });
  }

  const unsupportedFields = Object.keys(updates).filter(
    (field) => !["name", "skillTags"].includes(field)
  );

  if (unsupportedFields.length > 0) {
    return res.status(400).json({
      message: "Only name and skillTags can be updated.",
    });
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({
      message: "Provide name or skillTags to update.",
    });
  }

  let name = null;
  let skillTags = null;

  if (Object.hasOwn(updates, "name")) {
    if (typeof updates.name !== "string" || !updates.name.trim()) {
      return res.status(400).json({
        message: "Name must be a non-empty string.",
      });
    }

    name = updates.name.trim();
  }

  if (Object.hasOwn(updates, "skillTags")) {
    if (
      !Array.isArray(updates.skillTags) ||
      updates.skillTags.length > 50 ||
      updates.skillTags.some(
        (tag) =>
          typeof tag !== "string" ||
          !tag.trim() ||
          tag.trim().length > 50
      )
    ) {
      return res.status(400).json({
        message: "skillTags must be an array of up to 50 non-empty strings, each at most 50 characters.",
      });
    }

    skillTags = updates.skillTags.map((tag) => tag.trim());
  }

  try {
    const result = await pool.query(
      `UPDATE users
       SET name = COALESCE($2, name),
           skill_tags = COALESCE($3::text[], skill_tags)
       WHERE id = $1
       RETURNING id, name, email, role, skill_tags`,
      [req.user.userId, name, skillTags]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "Profile not found.",
      });
    }

    return res.status(200).json({
      message: "Profile updated successfully.",
      user: result.rows[0],
    });
  } catch (error) {
    console.error("Profile update error:", error.message);

    return res.status(500).json({
      message: "Could not update profile due to a server error.",
    });
  }
};

module.exports = { getOwnProfile, updateOwnProfile };
