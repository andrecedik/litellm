import React, { useEffect, useState } from "react";
import { Modal, Form, Input, Select } from "antd";
import MessageManager from "@/components/molecules/message_manager";
import { Button } from "@tremor/react";
import { updateClaudeCodePlugin } from "../networking";
import { isValidSemanticVersion, isValidEmail, isValidUrl, parseKeywords, formatKeywords } from "./helpers";
import { Plugin, PluginSource } from "./types";

const PREDEFINED_CATEGORIES = [
  "Development",
  "Productivity",
  "Learning",
  "Security",
  "Data & Analytics",
  "Integration",
  "Testing",
  "Documentation",
];

const { TextArea } = Input;
const { Option } = Select;

interface EditPluginFormProps {
  visible: boolean;
  plugin: Plugin | null;
  onClose: () => void;
  accessToken: string | null;
  onSuccess: () => void;
}

type SourceType = "github" | "url" | "git-subdir";

function sourceTypeFromPlugin(source: PluginSource): SourceType {
  if (source.source === "github" || source.source === "url" || source.source === "git-subdir") {
    return source.source;
  }
  return "github";
}

const EditPluginForm: React.FC<EditPluginFormProps> = ({ visible, plugin, onClose, accessToken, onSuccess }) => {
  const [form] = Form.useForm();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sourceType, setSourceType] = useState<SourceType>("github");

  useEffect(() => {
    if (visible && plugin) {
      const detectedSourceType = sourceTypeFromPlugin(plugin.source);
      setSourceType(detectedSourceType);
      form.setFieldsValue({
        name: plugin.name,
        sourceType: detectedSourceType,
        repo: plugin.source.repo ?? "",
        sourceUrl: plugin.source.url ?? "",
        sourcePath: plugin.source.path ?? "",
        version: plugin.version ?? "",
        description: plugin.description ?? "",
        authorName: plugin.author?.name ?? "",
        authorEmail: plugin.author?.email ?? "",
        homepage: plugin.homepage ?? "",
        category: plugin.category ?? undefined,
        keywords: formatKeywords(plugin.keywords),
        domain: plugin.domain ?? "",
        namespace: plugin.namespace ?? "",
      });
    }
  }, [visible, plugin, form]);

  const handleSourceTypeChange = (value: SourceType) => {
    setSourceType(value);
  };

  const handleSubmit = async (values: Record<string, string>) => {
    if (!accessToken || !plugin) {
      MessageManager.error("No access token available");
      return;
    }

    if (values.version && !isValidSemanticVersion(values.version)) {
      MessageManager.error("Version must be in semantic versioning format (e.g., 1.0.0)");
      return;
    }

    if (values.authorEmail && !isValidEmail(values.authorEmail)) {
      MessageManager.error("Invalid email format");
      return;
    }

    if (values.homepage && !isValidUrl(values.homepage)) {
      MessageManager.error("Invalid homepage URL format");
      return;
    }

    const source: PluginSource = buildSource(values);

    setIsSubmitting(true);
    try {
      const updateData: Parameters<typeof updateClaudeCodePlugin>[2] = { source };

      if (values.version) updateData.version = values.version.trim();
      if (values.description) updateData.description = values.description.trim();
      if (values.authorName || values.authorEmail) {
        updateData.author = { name: values.authorName?.trim() ?? "" };
        if (values.authorEmail) updateData.author.email = values.authorEmail.trim();
      }
      if (values.homepage) updateData.homepage = values.homepage.trim();
      if (values.category) updateData.category = values.category;
      if (values.keywords) updateData.keywords = parseKeywords(values.keywords);
      if (values.domain) updateData.domain = values.domain.trim();
      if (values.namespace) updateData.namespace = values.namespace.trim();

      await updateClaudeCodePlugin(accessToken, plugin.name, updateData);
      MessageManager.success("Skill updated successfully");
      onSuccess();
      onClose();
    } catch (error) {
      console.error("Error updating skill:", error);
      MessageManager.error("Failed to update skill");
    } finally {
      setIsSubmitting(false);
    }
  };

  function buildSource(values: Record<string, string>): PluginSource {
    if (sourceType === "github") {
      return { source: "github", repo: values.repo?.trim() };
    }
    if (sourceType === "git-subdir") {
      return { source: "git-subdir", url: values.sourceUrl?.trim(), path: values.sourcePath?.trim() };
    }
    return { source: "url", url: values.sourceUrl?.trim() };
  }

  const handleCancel = () => {
    onClose();
  };

  return (
    <Modal title="Edit Skill" open={visible} onCancel={handleCancel} footer={null} width={700} className="top-8">
      <Form form={form} layout="vertical" onFinish={handleSubmit} className="mt-4">
        {/* Name — disabled, immutable */}
        <Form.Item label="Skill Name" name="name" tooltip="Plugin name cannot be changed after registration">
          <Input disabled className="rounded-lg" />
        </Form.Item>

        {/* Source type selector */}
        <Form.Item label="Source Type" name="sourceType" rules={[{ required: true }]}>
          <Select onChange={handleSourceTypeChange} className="rounded-lg">
            <Option value="github">GitHub</Option>
            <Option value="url">Git URL</Option>
            <Option value="git-subdir">Git Subdirectory</Option>
          </Select>
        </Form.Item>

        {sourceType === "github" && (
          <Form.Item
            label="Repository"
            name="repo"
            rules={[{ required: true, message: "Repository is required (e.g., org/repo)" }]}
            tooltip="GitHub org/repo format"
          >
            <Input placeholder="org/my-plugin" className="rounded-lg" />
          </Form.Item>
        )}

        {(sourceType === "url" || sourceType === "git-subdir") && (
          <Form.Item
            label="Git URL"
            name="sourceUrl"
            rules={[{ required: true, message: "Git URL is required" }]}
            tooltip="Full URL to the git repository"
          >
            <Input placeholder="https://github.com/org/repo.git" className="rounded-lg" />
          </Form.Item>
        )}

        {sourceType === "git-subdir" && (
          <Form.Item
            label="Subdirectory Path"
            name="sourcePath"
            rules={[{ required: true, message: "Subdirectory path is required" }]}
            tooltip="Relative path within the repository (e.g., plugins/my-skill)"
          >
            <Input placeholder="plugins/my-skill" className="rounded-lg" />
          </Form.Item>
        )}

        {/* Domain and Namespace */}
        <div className="flex gap-4">
          <Form.Item label="Domain (Optional)" name="domain" tooltip="Top-level grouping in the Skill Hub" className="flex-1">
            <Input placeholder="Productivity" className="rounded-lg" />
          </Form.Item>
          <Form.Item label="Namespace (Optional)" name="namespace" tooltip="Sub-grouping within domain" className="flex-1">
            <Input placeholder="workflows" className="rounded-lg" />
          </Form.Item>
        </div>

        <Form.Item label="Description (Optional)" name="description">
          <TextArea rows={3} placeholder="A skill that helps with..." maxLength={500} className="rounded-lg" />
        </Form.Item>

        <Form.Item label="Category (Optional)" name="category">
          <Select placeholder="Select or type a category" allowClear showSearch optionFilterProp="children" className="rounded-lg">
            {PREDEFINED_CATEGORIES.map((cat) => (
              <Option key={cat} value={cat}>
                {cat}
              </Option>
            ))}
          </Select>
        </Form.Item>

        <Form.Item label="Keywords (Optional)" name="keywords" tooltip="Comma-separated keywords">
          <Input placeholder="search, web, api" className="rounded-lg" />
        </Form.Item>

        <Form.Item label="Version (Optional)" name="version" tooltip="Semantic version (e.g., 1.0.0)">
          <Input placeholder="1.0.0" className="rounded-lg" />
        </Form.Item>

        <Form.Item label="Author Name (Optional)" name="authorName">
          <Input placeholder="Your Name or Organization" className="rounded-lg" />
        </Form.Item>

        <Form.Item
          label="Author Email (Optional)"
          name="authorEmail"
          rules={[{ type: "email", message: "Please enter a valid email" }]}
        >
          <Input type="email" placeholder="author@example.com" className="rounded-lg" />
        </Form.Item>

        <Form.Item label="Homepage (Optional)" name="homepage">
          <Input placeholder="https://example.com" className="rounded-lg" />
        </Form.Item>

        <Form.Item className="mb-0 mt-6">
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={handleCancel} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" loading={isSubmitting}>
              {isSubmitting ? "Saving..." : "Save Changes"}
            </Button>
          </div>
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default EditPluginForm;
