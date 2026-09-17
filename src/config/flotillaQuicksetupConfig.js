// JS transcription of Flotilla_Deployment/config/flotilla_quicksetup_config.yaml
// (CIFAR10_IID + FedAT_CNN demo, 100 rounds) - the dataset cloud-init.sh.tftpl
// already generates on every VM. Kept as a plain object rather than adding a
// YAML-parsing dependency just to read one static file; this IS the
// `federated_learning_config` body flo_server.py's POST /execute_command
// expects (see flSessionAuto.service.js), matching how Flotilla_Deployment's
// own src/flo_session.py CLI loads and sends this same file.
export const flotillaQuicksetupConfig = {
  session_config: {
    session_id: 'facnn_fedavg_iid_docker',
    use_gpu: false,
    aggregator: 'fedavg_torch',
    aggregator_args: 'None',
    client_selection: 'fedavg',
    client_selection_args: { client_fraction: 1 },
    termination_condition: 'max_rounds',
    termination_condition_args: { max_rounds: 100 },
    checkpoint_interval: 1000,
    validation_round_interval: 1,
    generate_plots: false,
  },
  benchmark_config: {
    skip_benchmark: true,
    model_id: 'FedAT_CNN',
    model_dir: '../models/FedAT_CNN',
    model_class: 'FedAT_CNN',
    dataset: 'CIFAR10_IID',
    bench_minibatch_count: 500,
    batch_size: 4,
    learning_rate: 0.0001,
    timeout_duration_s: 180,
  },
  server_training_config: {
    model_dir: '../models/FedAT_CNN',
    validation_dataset: 'CIFAR10_IID',
    global_model_validation_batch_size: 100,
  },
  client_training_config: {
    model_id: 'FedAT_CNN',
    model_class: 'FedAT_CNN',
    dataset: 'CIFAR10_IID',
    epochs: 3,
    batch_size: 4,
    learning_rate: 0.00005,
    train_timeout_duration_s: 300,
    loss_function: 'crossentropy',
    loss_function_custom: true,
    optimizer: 'adam',
    optimizer_custom: true,
  },
  model_config: {
    use_custom_dataloader: false,
    custom_loader_args: 'None',
    use_custom_trainer: false,
    custom_trainer_args: 'None',
    use_custom_validator: false,
    custom_validator_args: 'None',
    model_args: { num_classes: 10 },
  },
};
