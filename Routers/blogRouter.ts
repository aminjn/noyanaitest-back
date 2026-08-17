import express from "express";

import * as authController from "../Controllers/authController";
import * as aclController from "../Controllers/aclController";
import * as uploadController from "../Controllers/uploadController";
import * as orgBlogController from "../Controllers/orgBlogController";

// Mounted at /api/v1/blog/:name (name = doctor/clinic/pharmacy/insurance/
// paraClinic), mirroring the /api/v1/acl/:name -> aclRouter pattern. Lets
// each organization panel manage its own blog posts. Owner-only (no
// secretary delegation) via aclController.useAcl(true), same as the
// secretary-management routes in aclRouter.
const router = express.Router({ mergeParams: true });

router.use(authController.protect);

router
  .route("/")
  .get(aclController.useAcl(true), orgBlogController.getMyBlogs)
  .post(
    aclController.useAcl(true),
    uploadController.upload.single("image"),
    orgBlogController.createMyBlog,
  );

router.route("/category").get(orgBlogController.getBlogCategories);

router
  .route("/:nodeId")
  .get(aclController.useAcl(true), orgBlogController.getMyBlog)
  .post(
    aclController.useAcl(true),
    uploadController.upload.single("image"),
    orgBlogController.editMyBlog,
  )
  .put(aclController.useAcl(true), orgBlogController.deleteMyBlog);

export default router;
